using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using SmartLogistics.SupplyChainService.Data;
using System.ComponentModel.DataAnnotations;
using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SmartLogistics.SupplyChainService.Controllers;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class StockMovement {
 [Required,RegularExpression("^(reserve|release|dispatch|deliver)$")] public string Action {get;set;}="";
 public Guid InventoryId {get;set;}
 [Range(1,1000000)] public int Quantity {get;set;}
 [Required,MaxLength(600)] public string Observation {get;set;}="";
}
public sealed class ShipmentAllocation {
 public Guid Id {get;set;} public Guid InventoryId {get;set;} public int Quantity {get;set;} public string State {get;set;}="";
}
public sealed class MovementEvidence {
 public Guid AllocationId {get;set;} public string Action {get;set;}=""; public string Actor {get;set;}=""; public string Observation {get;set;}=""; public DateTime RecordedAt {get;set;}
}
public sealed class SavedMovement {
 public Guid Id {get;set;} public string RequestHash {get;set;}=""; public string Action {get;set;}="";
}
[ApiController,Authorize,Route("api/v1/shipment-stock/{shipmentId:int:min(1)}")]
public class ShipmentStockController(ApplicationDbContext db,IHttpClientFactory clients,IConfiguration config):ControllerBase {
 // The carrier projection is owned by Node and may use a different PostgreSQL database.
 // Pass the verified operator's credential through its tenant-scoped read boundary.
 async Task<IActionResult?> VerifyShipment(int shipmentId,bool requireActive,CancellationToken ct) {
  var node=config["NODE_API_URL"]??"http://127.0.0.1:3001";
  if(!node.StartsWith("http://")&&!node.StartsWith("https://"))node="http://"+node;
  using var req=new HttpRequestMessage(HttpMethod.Get,node.TrimEnd('/')+"/api/operations/shipments/"+shipmentId);
  if(Request.Headers.ContainsKey("Authorization"))req.Headers.TryAddWithoutValidation("Authorization",Request.Headers.Authorization.ToString());
  else if(Request.Cookies.TryGetValue("imsop_access",out var cookie))req.Headers.TryAddWithoutValidation("Cookie","imsop_access="+cookie);
  try {
   using var response=await clients.CreateClient("session-boundary").SendAsync(req,ct);
   if(response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized)return StatusCode((int)response.StatusCode);
   if(!response.IsSuccessStatusCode)return StatusCode(503,new{error="Shipment service is unavailable"});
   var item=await response.Content.ReadFromJsonAsync<JsonElement>(ct);
   if(!item.TryGetProperty("id",out var id)||id.GetInt32()!=shipmentId)return StatusCode(503,new{error="Shipment identity was not confirmed"});
   if(requireActive&&(item.GetProperty("status").GetString() is "delivered" or "cancelled"))return Conflict(new{error="The carrier shipment is closed"});
   return null;
  }catch(Exception ex) when((ex is HttpRequestException or JsonException or OperationCanceledException) && !ct.IsCancellationRequested){return StatusCode(503,new{error="Shipment service is unavailable"});}
 }
 IQueryable<ShipmentAllocation> Allocations(Guid org,Guid workspace,int shipmentId)=>db.Database.SqlQuery<ShipmentAllocation>($"""
 SELECT id AS "Id",inventory_id AS "InventoryId",quantity AS "Quantity",state AS "State" FROM supply_chain.shipment_allocations
 WHERE organization_id={org} AND workspace_id={workspace} AND shipment_id={shipmentId}
 """);
 static string Status(IReadOnlyList<ShipmentAllocation> rows) {
  var active=rows.Where(a=>a.State!="released").ToArray();
  if(active.Length==0)return rows.Count==0?"Not allocated":"Released";
  if(active.All(a=>a.State=="delivered"))return "Delivered";
  if(active.Any(a=>a.State=="delivered"))return "Partially delivered";
  if(active.All(a=>a.State=="dispatched"))return "Dispatched";
  if(active.Any(a=>a.State=="dispatched"))return "Partially dispatched";
  return "Reserved";
 }
 [HttpGet("status"),Authorize(Roles="admin,engineer,analyst,user")]
 public async Task<IActionResult> Fulfillment(int shipmentId,CancellationToken ct) {
  if(db.OrganizationId is not Guid org||!Guid.TryParse(User.FindFirstValue("workspace_id"),out var workspace))return Forbid();
  var error=await VerifyShipment(shipmentId,false,ct);if(error!=null)return error;
  var rows=await Allocations(org,workspace,shipmentId).ToListAsync(ct);
  return Ok(new{operationalStatus=Status(rows)});
 }
 [HttpGet,Authorize(Roles="admin,engineer,analyst")]
 public async Task<IActionResult> Snapshot(int shipmentId,[FromQuery]int offset=0,CancellationToken ct=default) {
  if(db.OrganizationId is not Guid org||!Guid.TryParse(User.FindFirstValue("workspace_id"),out var workspace))return Forbid();
  if(offset<0||offset>1000000)return BadRequest();
  var error=await VerifyShipment(shipmentId,false,ct);if(error!=null)return error;
  var choices=from stock in db.Inventories join p in db.Products on stock.ProductId equals p.Id join w in db.Warehouses on stock.WarehouseId equals w.Id
    orderby p.Name,w.Name,stock.Id select new{stock.Id,product=p.Name,warehouse=w.Name,available=stock.QuantityAvailable};
  var sources=await choices.Skip(offset).Take(51).ToListAsync(ct);
  var allocations=await Allocations(org,workspace,shipmentId).OrderBy(a=>a.Id).ToListAsync(ct);
  var events=await db.Database.SqlQuery<MovementEvidence>($"""
   SELECT e.allocation_id AS "AllocationId",e.action AS "Action",e.actor AS "Actor",e.observation AS "Observation",e.recorded_at AS "RecordedAt"
   FROM supply_chain.shipment_stock_events e JOIN supply_chain.shipment_allocations a ON e.allocation_id=a.id
   WHERE a.organization_id={org} AND a.workspace_id={workspace} AND a.shipment_id={shipmentId}
   ORDER BY e.recorded_at DESC,e.id DESC LIMIT 100
   """).ToListAsync(ct);
  return Ok(new{stock=sources.Take(50),hasMore=sources.Count>50,operationalStatus=Status(allocations),allocations,events});
 }
 [HttpPost,Authorize(Roles="admin,engineer")]
 public async Task<IActionResult> Move(int shipmentId,StockMovement request,[FromHeader(Name="Idempotency-Key")]string? key,CancellationToken ct){
  if(db.OrganizationId is not Guid org||!Guid.TryParse(User.FindFirstValue("workspace_id"),out var workspace))return Forbid();
  if(!Guid.TryParse(key,out var requestKey)||request.InventoryId==Guid.Empty||string.IsNullOrWhiteSpace(request.Observation))return BadRequest(new{error="Enter stock, an observation, and a valid movement reference"});
  var check=await VerifyShipment(shipmentId,false,ct);if(check!=null)return check;
  var hash=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new{workspace,shipmentId,request}))));
  await using var tx=await db.Database.BeginTransactionAsync(ct);
  var keyLock=$"{org}:shipment-request:{requestKey}";await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtextextended({keyLock},0))",ct);
  var previous=await db.Database.SqlQuery<SavedMovement>($"""SELECT allocation_id AS "Id",request_hash AS "RequestHash",action AS "Action" FROM supply_chain.shipment_stock_events WHERE organization_id={org} AND request_key={requestKey}""").SingleOrDefaultAsync(ct);
  if(previous!=null)return previous.RequestHash==hash?Ok(new{allocationId=previous.Id,action=previous.Action,duplicate=true}):Conflict(new{error="Movement reference already used for different content"});
  var identity=await db.Inventories.AsNoTracking().Where(i=>i.Id==request.InventoryId).Select(i=>new{i.WarehouseId,i.ProductId}).SingleOrDefaultAsync(ct);
  if(identity==null)return NotFound();
  var stockLock=$"{org}:stock:{identity.WarehouseId}:{identity.ProductId}";await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtextextended({stockLock},0))",ct);
  var stock=await db.Inventories.SingleAsync(i=>i.Id==request.InventoryId,ct);
  var allocation=await Allocations(org,workspace,shipmentId).Where(a=>a.InventoryId==request.InventoryId).SingleOrDefaultAsync(ct);
  Guid allocationId;
  if(request.Action=="reserve"){
   if(allocation!=null)return Conflict(new{error="This shipment already has a movement for this stock line"});
   if(request.Quantity>stock.QuantityAvailable)return Conflict(new{error="Insufficient available stock"});
   var active=await VerifyShipment(shipmentId,true,ct);if(active!=null)return active;
   allocationId=Guid.NewGuid();stock.QuantityReserved=checked(stock.QuantityReserved+request.Quantity);
   await db.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO supply_chain.shipment_allocations(id,organization_id,workspace_id,shipment_id,inventory_id,quantity,state) VALUES({allocationId},{org},{workspace},{shipmentId},{stock.Id},{request.Quantity},'reserved')",ct);
  }else{
   if(allocation==null)return NotFound();
   if(request.Quantity!=allocation.Quantity)return Conflict(new{error="Quantity differs from the saved reservation"});
   var state=(request.Action,allocation.State) switch {("release","reserved")=>"released",("dispatch","reserved")=>"dispatched",("deliver","dispatched")=>"delivered",_=>null};
   if(state==null)return Conflict(new{error="Movement is out of sequence"});
   if(state=="dispatched"||state=="released") {
    if(stock.QuantityReserved<request.Quantity||(state=="dispatched"&&stock.QuantityOnHand<request.Quantity))return Conflict(new{error="Stock is inconsistent; reconcile the warehouse"});
    stock.QuantityReserved-=request.Quantity;if(state=="dispatched")stock.QuantityOnHand-=request.Quantity;
   }
   allocationId=allocation.Id;
   await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE supply_chain.shipment_allocations SET state={state} WHERE id={allocationId}",ct);
  }
  var actor=User.FindFirstValue(ClaimTypes.NameIdentifier)??User.FindFirstValue("id");if(string.IsNullOrWhiteSpace(actor))return Forbid();
  await db.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO supply_chain.shipment_stock_events(id,organization_id,request_key,allocation_id,action,request_hash,actor,observation) VALUES({Guid.NewGuid()},{org},{requestKey},{allocationId},{request.Action},{hash},{actor},{request.Observation.Trim()})",ct);
  await db.SaveChangesAsync(ct);await tx.CommitAsync(ct);
  return Ok(new{allocationId,action=request.Action,duplicate=false});
 }
}

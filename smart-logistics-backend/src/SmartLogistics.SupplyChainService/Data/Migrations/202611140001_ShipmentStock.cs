using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
namespace SmartLogistics.SupplyChainService.Data.Migrations;

[DbContext(typeof(ApplicationDbContext))]
[Migration("202611140001_ShipmentStock")]
public class ShipmentStock : Migration {
 protected override void Up(MigrationBuilder m) => m.Sql("""
 CREATE TABLE supply_chain.shipment_allocations (
   id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL,
   shipment_id integer NOT NULL CHECK(shipment_id>0), inventory_id uuid NOT NULL REFERENCES supply_chain.inventories(id),
   quantity integer NOT NULL CHECK(quantity>0), state text NOT NULL CHECK(state IN ('reserved','released','dispatched','delivered')),
   created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,workspace_id,shipment_id,inventory_id));
 CREATE TABLE supply_chain.shipment_stock_events (
   id uuid PRIMARY KEY, organization_id uuid NOT NULL, request_key uuid NOT NULL, allocation_id uuid NOT NULL REFERENCES supply_chain.shipment_allocations(id),
   action text NOT NULL, request_hash text NOT NULL, actor text NOT NULL, observation text NOT NULL,
   recorded_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,request_key));
 """);
 protected override void Down(MigrationBuilder m)=>throw new NotSupportedException("Shipment movement evidence is append-only.");
}

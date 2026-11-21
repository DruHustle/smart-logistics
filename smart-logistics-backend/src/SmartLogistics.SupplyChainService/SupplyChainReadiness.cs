namespace SmartLogistics.SupplyChainService;

/// <summary>Fail-closed database readiness, without exposing connection errors publicly.</summary>
public static class SupplyChainReadiness
{
    public const string RequiredMigration = "202611140001_ShipmentStock";

    public static async Task<bool> CheckAsync(
        Func<CancellationToken, Task<IEnumerable<string>>> fetchAppliedMigrations,
        CancellationToken requestCancellation)
    {
        ArgumentNullException.ThrowIfNull(fetchAppliedMigrations);
        try
        {
            var applied = await fetchAppliedMigrations(requestCancellation);
            return applied.Contains(RequiredMigration);
        }
        catch (OperationCanceledException) when (requestCancellation.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception)
        {
            // An unreachable or unqueryable database is never ready.
            return false;
        }
    }
}

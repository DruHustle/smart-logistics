using Xunit;

namespace SmartLogistics.SupplyChainService.Tests;

public class SupplyChainReadinessTests
{
    [Fact]
    public async Task OnlyReviewedMigrationQualifiesReadiness()
    {
        Assert.True(await SupplyChainReadiness.CheckAsync(
            _ => Task.FromResult<IEnumerable<string>>(new[] {
                "202610270002_PurchaseReceiving", SupplyChainReadiness.RequiredMigration
            }), CancellationToken.None));
        Assert.False(await SupplyChainReadiness.CheckAsync(
            _ => Task.FromResult<IEnumerable<string>>(new[] { "202610270002_PurchaseReceiving" }),
            CancellationToken.None));
    }

    [Fact]
    public async Task DisconnectedDatabaseFailsClosed()
    {
        Assert.False(await SupplyChainReadiness.CheckAsync(
            _ => Task.FromException<IEnumerable<string>>(new InvalidOperationException("synthetic error")),
            CancellationToken.None));
    }

    [Fact]
    public async Task CancelledCallerStillPropagatesCancellation()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            SupplyChainReadiness.CheckAsync(
                token => Task.FromCanceled<IEnumerable<string>>(token), cts.Token));
    }
}

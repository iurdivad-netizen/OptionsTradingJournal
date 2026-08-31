import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DollarSign, Percent, TrendingUp, BarChart3, Target, Activity, Calendar, Award } from "lucide-react";
import {
  EquityCurveChart,
  DailyPnLChart,
  WinRateChart,
  SymbolPerformanceChart,
  TimeClassificationChart,
  RiskRewardScatterChart,
  PnLDistributionChart,
  StreakChart,
} from "@/components/charts/performance-charts";
import { DailyPerformanceCalendar } from "@/components/charts/daily-performance-calendar";
import { calculateDrawdown, calculateSharpeRatio, getStreakAnalysis } from "@/lib/trade-calculations";
import type { Trade } from "@shared/schema";
import { groupIntoPositions } from "@shared/positions";

interface PerformanceData {
  totalPnL: number;
  winRate: number;
  avgRR: number;
  totalTrades: number;
  symbolPerformance: Record<string, number>;
  timePerformance: Record<string, number>;
  dailyPnL: Record<string, number>;
  trades: Trade[];
  totalFees?: number;
  basis?: 'net' | 'gross';
}

export default function PerformanceSectionMobile() {
  // Net counts the commissions and fees already deducted from each trade;
  // gross shows what the same trades made before that drag.
  const [basis, setBasis] = useState<'net' | 'gross'>('net');

  // Fetch performance data
  const { data: performanceData, isLoading } = useQuery<PerformanceData>({
    queryKey: ['/api/performance/analytics', basis],
    queryFn: () =>
      fetch(`/api/performance/analytics?basis=${basis}`, { credentials: 'include' })
        .then(res => res.json()),
  });

  // Fetch all trades
  const { data: storedTrades = [] } = useQuery<Trade[]>({
    queryKey: ['/api/trades'],
  });

  // Everything below works from the chosen basis, so the charts, streaks and
  // strategy breakdown agree with the headline figures.
  const allTrades = useMemo(
    () =>
      basis === 'net'
        ? storedTrades
        : storedTrades.map(trade => ({
            ...trade,
            pnl: trade.pnl === null ? null : trade.pnl - (trade.fees ?? 0),
          })),
    [storedTrades, basis],
  );

  // Fetch account balance
  const { data: accountBalanceData } = useQuery<{value: string}>({
    queryKey: ['/api/settings/account_balance'],
  });

  const startingBalance = accountBalanceData?.value ? parseInt(accountBalanceData.value) : 28000;

  const analytics = useMemo(() => {
    if (!performanceData || !allTrades) {
      return {
        completedTrades: [],
        completedPositions: [],
        equityCurve: [],
        drawdown: { maxDrawdown: 0, maxDrawdownPercent: 0, currentDrawdown: 0 },
        sharpeRatio: 0,
        streakAnalysis: { currentStreak: 0, maxWinStreak: 0, maxLossStreak: 0, streaks: [] },
        pnlDistribution: {},
        riskRewardData: [],
        monthlyCalendar: {},
      };
    }

    const completedTrades = allTrades.filter(trade => trade.pnl !== null);

    // A multi-leg position is stored one row per leg, so anything that counts
    // or averages trades has to work from positions - otherwise every spread
    // contributes a win and a loss. Each closed position is collapsed onto its
    // first leg carrying the position's total, so the money is unchanged.
    const completedPositions = groupIntoPositions(completedTrades)
      .filter(position => position.pnl !== null)
      .map(position => ({ ...position.legs[0], pnl: position.pnl as number }));

    // Calculate equity curve. Trades arrive newest first, so they have to be
    // put back in the order they happened before the balance is accumulated -
    // otherwise the curve runs backwards through time and the drawdown taken
    // from it describes a sequence that never occurred.
    const closedInOrder = completedPositions
      .filter(trade => trade.exitTime)
      .sort((a, b) => new Date(a.exitTime!).getTime() - new Date(b.exitTime!).getTime());

    let balance = startingBalance;
    // Seed the curve just before the first trade rather than at today, so the
    // opening balance is not plotted after every trade that followed it.
    const openingDate = closedInOrder.length > 0
      ? new Date(new Date(closedInOrder[0].exitTime!).getTime() - 24 * 60 * 60 * 1000)
      : new Date();
    const equityCurve = [{ date: openingDate.toISOString(), balance }];

    closedInOrder.forEach(trade => {
      balance += trade.pnl || 0;
      equityCurve.push({
        date: new Date(trade.exitTime!).toISOString(),
        balance
      });
    });

    // Calculate drawdown
    const balanceHistory = equityCurve.map(point => point.balance);
    const drawdown = calculateDrawdown(balanceHistory);

    // Calculate Sharpe ratio
    const dailyReturns = Object.values(performanceData.dailyPnL).map(pnl => pnl / startingBalance);
    const sharpeRatio = calculateSharpeRatio(dailyReturns);

    // Streak analysis
    const streakAnalysis = getStreakAnalysis(completedPositions);

    // P&L distribution
    const bucketSize = 100;
    const pnlDistribution: Record<string, number> = {};
    completedPositions.forEach(trade => {
      const bucket = Math.floor((trade.pnl || 0) / bucketSize) * bucketSize;
      pnlDistribution[bucket.toString()] = (pnlDistribution[bucket.toString()] || 0) + 1;
    });

    // Risk/Reward scatter data
    const riskRewardData = completedPositions.map(trade => {
      const risk = Math.abs(trade.entryPrice * trade.quantity * 100 * 0.1); // Assume 10% risk
      return {
        x: risk,
        y: trade.pnl || 0,
        id: trade.id
      };
    });

    // Monthly calendar data
    const monthlyCalendar: Record<string, number> = {};
    completedPositions.forEach(trade => {
      if (trade.exitTime) {
        const monthKey = new Date(trade.exitTime).toLocaleDateString('en-US', { 
          year: 'numeric', 
          month: 'short' 
        });
        monthlyCalendar[monthKey] = (monthlyCalendar[monthKey] || 0) + (trade.pnl || 0);
      }
    });

    return {
      completedTrades,
      completedPositions,
      equityCurve,
      drawdown,
      sharpeRatio,
      streakAnalysis,
      pnlDistribution,
      riskRewardData,
      monthlyCalendar,
    };
  }, [performanceData, allTrades, startingBalance]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading performance data...</div>
      </div>
    );
  }

  if (!performanceData) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">No performance data available</div>
      </div>
    );
  }

  // How each kind of position has actually done. Imported trades carry the
  // strategy they were placed as, which makes this the most direct answer to
  // "which of these is working".
  const strategyBreakdown = useMemo(() => {
    const byStrategy = new Map<string, { pnl: number; wins: number; total: number }>();
    for (const position of analytics.completedPositions) {
      const name = position.strategyType || 'Unclassified';
      const entry = byStrategy.get(name) ?? { pnl: 0, wins: 0, total: 0 };
      entry.pnl += position.pnl ?? 0;
      entry.total += 1;
      if ((position.pnl ?? 0) > 0) entry.wins += 1;
      byStrategy.set(name, entry);
    }
    return Array.from(byStrategy.entries())
      .map(([name, entry]) => ({ name, ...entry, winRate: (entry.wins / entry.total) * 100 }))
      .sort((a, b) => b.pnl - a.pnl);
  }, [analytics.completedPositions]);

  const winningTrades = analytics.completedPositions.filter(t => t.pnl! > 0);
  const losingTrades = analytics.completedPositions.filter(t => t.pnl! <= 0);
  const currentBalance = startingBalance + performanceData.totalPnL;

  // Convert daily P&L data for heatmap
  const heatmapData = useMemo(() => {
    if (!performanceData?.dailyPnL || !allTrades) return [];
    
    // Group trades by date and calculate daily P&L
    const dailyData: Record<string, { pnl: number; trades: number }> = {};
    
    allTrades.forEach(trade => {
      if (trade.pnl !== null && trade.tradeDate) {
        // Normalize to local date to avoid timezone shifts
        const tradeDate = new Date(trade.tradeDate);
        const year = tradeDate.getFullYear();
        const month = tradeDate.getMonth();
        const day = tradeDate.getDate();
        const normalizedDate = new Date(year, month, day);
        const dateKey = normalizedDate.toDateString();
        
        if (!dailyData[dateKey]) {
          dailyData[dateKey] = { pnl: 0, trades: 0 };
        }
        dailyData[dateKey].pnl += trade.pnl;
        dailyData[dateKey].trades += 1;
      }
    });
    
    const result = Object.entries(dailyData).map(([dateStr, data]) => {
      // Parse the date string properly to avoid timezone issues
      const parsedDate = new Date(dateStr);
      // Create a new date in local timezone
      const localDate = new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate());
      return {
        date: localDate,
        pnl: data.pnl,
        trades: data.trades
      };
    });
    

    return result;
  }, [performanceData?.dailyPnL, allTrades]);

  return (
    <div className="w-full max-w-full overflow-hidden space-y-6">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-xl font-bold">Performance Analytics</h2>
        <p className="text-muted-foreground">Track your trading performance and identify patterns</p>
      </div>

      {/* Performance Calendar - TOP PRIORITY */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Daily Performance Calendar</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="w-full">
            <DailyPerformanceCalendar 
              data={heatmapData}
              onDateClick={(date) => {
                // Handle date click navigation if needed
                console.log('Calendar date clicked:', date);
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Key Metrics - Mobile Optimized */}
      <div className="grid grid-cols-1 gap-4">
        {/* Total P&L */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Total P&L</p>
                <p className={`text-2xl font-bold ${performanceData.totalPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {performanceData.totalPnL >= 0 ? '+' : ''}${performanceData.totalPnL.toFixed(2)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Account: ${currentBalance.toLocaleString()}
                </p>
              </div>
              <div className="w-12 h-12 bg-green-100 dark:bg-green-900/20 rounded-lg flex items-center justify-center">
                <DollarSign className="w-6 h-6 text-green-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Win Rate */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Win Rate</p>
                <p className="text-2xl font-bold text-blue-600">
                  {performanceData.winRate.toFixed(1)}%
                </p>
                <p className="text-xs text-muted-foreground">
                  {winningTrades.length}W / {losingTrades.length}L
                </p>
              </div>
              <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/20 rounded-lg flex items-center justify-center">
                <Percent className="w-6 h-6 text-blue-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Avg R:R */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Avg R:R</p>
                <p className="text-2xl font-bold text-orange-600">
                  1:{performanceData.avgRR.toFixed(1)}
                </p>
                <p className="text-xs text-muted-foreground">Risk:Reward</p>
              </div>
              <div className="w-12 h-12 bg-orange-100 dark:bg-orange-900/20 rounded-lg flex items-center justify-center">
                <Target className="w-6 h-6 text-orange-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Total Trades */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Total Trades</p>
                <p className="text-2xl font-bold text-foreground">{performanceData.totalTrades}</p>
                <p className="text-xs text-muted-foreground">
                  {analytics.completedPositions.length} completed
                </p>
              </div>
              <div className="w-12 h-12 bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-center">
                <BarChart3 className="w-6 h-6 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Net / gross toggle */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={basis === 'net' ? 'default' : 'outline'}
            onClick={() => setBasis('net')}
          >
            After fees
          </Button>
          <Button
            type="button"
            size="sm"
            variant={basis === 'gross' ? 'default' : 'outline'}
            onClick={() => setBasis('gross')}
          >
            Before fees
          </Button>
        </div>
        {typeof performanceData.totalFees === 'number' && performanceData.totalFees !== 0 && (
          <p className="text-sm text-muted-foreground">
            Commissions, fees and assignment costs:{' '}
            <span className="font-medium text-foreground">
              ${Math.abs(performanceData.totalFees).toFixed(2)}
            </span>
          </p>
        )}
      </div>

      {/* Performance by strategy */}
      {strategyBreakdown.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Performance by Strategy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {strategyBreakdown.map((strategy) => (
              <div key={strategy.name} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium truncate">{strategy.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {strategy.total} position{strategy.total === 1 ? '' : 's'} - {strategy.winRate.toFixed(0)}% won
                  </p>
                </div>
                <p className={`font-semibold flex-shrink-0 ${strategy.pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {strategy.pnl >= 0 ? '+' : ''}${strategy.pnl.toFixed(2)}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Advanced Metrics - Mobile Layout */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Max Drawdown</p>
              </div>
              <p className="text-lg font-bold text-red-600">
                ${analytics.drawdown.maxDrawdown.toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground">
                {analytics.drawdown.maxDrawdownPercent.toFixed(1)}%
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Award className="w-4 h-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Sharpe Ratio</p>
              </div>
              <p className="text-lg font-bold text-purple-600">
                {analytics.sharpeRatio.toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground">
                Risk-adj return
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Win Streak</p>
              </div>
              <p className="text-lg font-bold text-green-600">
                {analytics.streakAnalysis.maxWinStreak}
              </p>
              <p className="text-xs text-muted-foreground">
                Current: {analytics.streakAnalysis.currentStreak}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Avg/Trade</p>
              </div>
              <p className="text-lg font-bold text-blue-600">
                ${analytics.completedPositions.length > 0 
                  ? (performanceData.totalPnL / analytics.completedPositions.length).toFixed(2)
                  : '0.00'}
              </p>
              <p className="text-xs text-muted-foreground">
                Per completed trade
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts Section - Mobile Optimized */}
      <div className="space-y-6">
        {/* Equity Curve */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Account Growth</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[200px] w-full">
              <EquityCurveChart data={analytics.equityCurve} />
            </div>
          </CardContent>
        </Card>

        {/* Daily P&L */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Daily P&L</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[200px] w-full">
              <DailyPnLChart data={performanceData.dailyPnL} />
            </div>
          </CardContent>
        </Card>



        {/* Symbol Performance */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Symbol Performance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[200px] w-full">
              <SymbolPerformanceChart data={performanceData.symbolPerformance} />
            </div>
          </CardContent>
        </Card>

        {/* Time Classification */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Time of Day Performance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[200px] w-full">
              <TimeClassificationChart data={performanceData.timePerformance} />
            </div>
          </CardContent>
        </Card>

        {/* Win Rate Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Win Rate Analysis</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[200px] w-full">
              <WinRateChart 
                wins={winningTrades.length}
                losses={losingTrades.length}
              />
            </div>
          </CardContent>
        </Card>

        {/* P&L Distribution */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">P&L Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[200px] w-full">
              <PnLDistributionChart data={analytics.pnlDistribution} />
            </div>
          </CardContent>
        </Card>

        {/* Risk/Reward Scatter */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Risk vs Reward</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[250px] w-full">
              <RiskRewardScatterChart data={analytics.riskRewardData} />
            </div>
          </CardContent>
        </Card>

        {/* Streak Analysis */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Streak Analysis</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <p className="text-2xl font-bold text-green-600">
                    {analytics.streakAnalysis.maxWinStreak}
                  </p>
                  <p className="text-sm text-muted-foreground">Max Win Streak</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-red-600">
                    {analytics.streakAnalysis.maxLossStreak}
                  </p>
                  <p className="text-sm text-muted-foreground">Max Loss Streak</p>
                </div>
                <div>
                  <p className={`text-2xl font-bold ${analytics.streakAnalysis.currentStreak >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {analytics.streakAnalysis.currentStreak}
                  </p>
                  <p className="text-sm text-muted-foreground">Current Streak</p>
                </div>
              </div>
              <div className="h-[150px] w-full">
                <StreakChart streaks={analytics.streakAnalysis.streaks} />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Summary Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Performance Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3">
              <div className="flex justify-between items-center py-2 border-b">
                <span className="text-muted-foreground">Starting Balance</span>
                <span className="font-medium">${startingBalance.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b">
                <span className="text-muted-foreground">Current Balance</span>
                <span className="font-medium">${currentBalance.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b">
                <span className="text-muted-foreground">Total Return</span>
                <span className={`font-medium ${performanceData.totalPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {((performanceData.totalPnL / startingBalance) * 100).toFixed(2)}%
                </span>
              </div>
              <div className="flex justify-between items-center py-2 border-b">
                <span className="text-muted-foreground">Best Trade</span>
                <span className="font-medium text-green-600">
                  ${Math.max(...analytics.completedTrades.map(t => t.pnl || 0)).toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="text-muted-foreground">Worst Trade</span>
                <span className="font-medium text-red-600">
                  ${Math.min(...analytics.completedTrades.map(t => t.pnl || 0)).toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
import React, { useState, useCallback, useMemo } from 'react';
import { useDropzone } from 'react-dropzone';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Upload, FileText, AlertCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { format } from 'date-fns';
import { classifyTimeOfDay } from '@/lib/trade-calculations';
import {
  describeEntry,
  describeExit,
  isTastytradeExport,
  parseTastytradeExport,
  type MatchResult,
  type MatchedTrade,
  type TradeDateBasis,
} from '@/lib/tastytrade-import';

interface ParsedTrade {
  ticker: string;
  type: 'calls' | 'puts';
  quantity: number;
  strikePrice: number;
  entryPrice: number;
  exitPrice: number;
  expirationDate: string;
  tradeDate: string;
  pnl: number;
  symbol: string; // Original E*TRADE symbol
}

interface TradePayload {
  ticker: string;
  type: 'calls' | 'puts';
  quantity: number;
  strikePrice: number;
  entryPrice: number;
  exitPrice?: number;
  entryTime: Date;
  exitTime?: Date;
  expirationDate: Date;
  tradeDate: Date;
  pnl?: number;
  entryReason: string;
  exitReason: string;
  timeClassification?: string;
  direction?: string;
  groupId?: string;
  strategyType?: string;
  playbookId: number;
}

interface PreviewRow {
  ticker: string;
  strategyType: string;
  type: 'calls' | 'puts';
  direction: 'long' | 'short' | null;
  quantity: number;
  strikePrice: number;
  entryPrice: number;
  exitPrice: number | null;
  pnl: number | null;
  note: string;
}

interface BulkTradeUploadProps {
  onClose: () => void;
  onSuccess: () => void;
}

export default function BulkTradeUpload({ onClose, onSuccess }: BulkTradeUploadProps) {
  const [parsedTrades, setParsedTrades] = useState<ParsedTrade[]>([]);
  const [tastyResult, setTastyResult] = useState<MatchResult | null>(null);
  const [tastyContent, setTastyContent] = useState<string | null>(null);
  const [tradeDateBasis, setTradeDateBasis] = useState<TradeDateBasis>('exit');
  const [includeOpenPositions, setIncludeOpenPositions] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Parse E*TRADE symbol format: -SPY250703C618
  const parseSymbol = (symbol: string) => {
    // Remove leading dash if present
    const cleanSymbol = symbol.startsWith('-') ? symbol.substring(1) : symbol;

    // Match pattern: TICKER + YYMMDD + C/P + STRIKE
    const match = cleanSymbol.match(/^([A-Z]+)(\d{6})([CP])(\d+)$/);

    if (!match) {
      throw new Error(`Invalid symbol format: ${symbol}`);
    }

    const [, ticker, dateStr, optionType, strikeStr] = match;

    // Parse date: YYMMDD
    const year = 2000 + parseInt(dateStr.substring(0, 2));
    const month = parseInt(dateStr.substring(2, 4)) - 1; // Month is 0-indexed
    const day = parseInt(dateStr.substring(4, 6));
    const expirationDate = new Date(year, month, day);

    // Parse strike price (divide by 1000 for standard format)
    const strikePrice = parseInt(strikeStr) / 1000;

    return {
      ticker,
      type: optionType === 'C' ? 'calls' as const : 'puts' as const,
      strikePrice,
      expirationDate: expirationDate.toISOString().split('T')[0]
    };
  };

  // Parse CSV content
  const parseCSV = (content: string): ParsedTrade[] => {
    const lines = content.split('\n').filter(line => line.trim());
    const trades: ParsedTrade[] = [];

    // Find the header row and data rows
    let dataStartIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('Symbol') && lines[i].includes('Basis/Share') && lines[i].includes('Proceeds/Share')) {
        dataStartIndex = i + 1;
        break;
      }
    }

    if (dataStartIndex === -1) {
      throw new Error('Could not find data header row. Please ensure the CSV includes Symbol, Basis/Share, Proceeds/Share columns.');
    }

    for (let i = dataStartIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('TOTALS')) continue;

      // Split by tabs or commas, handling quoted values
      const columns = line.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
        .map(col => col.replace(/"/g, '').trim());

      if (columns.length < 8) continue; // Need at least symbol, basis, proceeds, quantity

      try {
        const symbol = columns[0];
        const basisStr = columns[1];
        const proceedsStr = columns[2];
        const quantityStr = columns[7]; // Quantity column

        // Skip if not a valid options symbol
        if (!symbol.match(/^-?[A-Z]+\d{6}[CP]\d+$/)) continue;

        const symbolData = parseSymbol(symbol);
        const entryPrice = parseFloat(basisStr);
        const exitPrice = parseFloat(proceedsStr);
        const quantity = parseInt(quantityStr);
        const pnl = (exitPrice - entryPrice) * quantity * 100; // Options multiplier

        // Use today's date as trade date (can be edited later)
        const today = new Date();
        const tradeDate = today.toISOString().split('T')[0];

        trades.push({
          ...symbolData,
          entryPrice,
          exitPrice,
          quantity,
          pnl,
          tradeDate,
          symbol
        });
      } catch (error) {
        console.warn(`Skipping invalid row: ${line}`, error);
      }
    }

    return trades;
  };

  // File drop handler
  const onDrop = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;

        // A tastytrade export is a transaction log rather than a gain/loss
        // report, so it needs its own parser and position matching.
        if (isTastytradeExport(content)) {
          const result = parseTastytradeExport(content, { tradeDateBasis });

          if (result.trades.length === 0 && result.openPositions.length === 0) {
            toast({
              title: "No Trades Found",
              description: "No options transactions were found in this tastytrade export.",
              variant: "destructive",
            });
            return;
          }

          setParsedTrades([]);
          setTastyContent(content);
          setTastyResult(result);
          toast({
            title: "tastytrade Export Parsed",
            description: `Matched ${result.trades.length} closed trades, ${result.openPositions.length} still open.`,
          });
          return;
        }

        const trades = parseCSV(content);

        if (trades.length === 0) {
          toast({
            title: "No Trades Found",
            description: "No valid options trades found in the uploaded file.",
            variant: "destructive",
          });
          return;
        }

        setTastyResult(null);
        setTastyContent(null);
        setParsedTrades(trades);
        toast({
          title: "File Parsed Successfully",
          description: `Found ${trades.length} trades ready for upload.`,
        });
      } catch (error) {
        toast({
          title: "Parse Error",
          description: error instanceof Error ? error.message : "Failed to parse file.",
          variant: "destructive",
        });
      }
    };

    reader.readAsText(file);
  }, [toast, tradeDateBasis]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
      'text/plain': ['.txt'],
      'text/tab-separated-values': ['.tsv'],
    },
    multiple: false,
  });

  const handleBasisChange = (basis: TradeDateBasis) => {
    setTradeDateBasis(basis);
    if (tastyContent) {
      setTastyResult(parseTastytradeExport(tastyContent, { tradeDateBasis: basis }));
    }
  };

  const tastyTrades: MatchedTrade[] = useMemo(() => {
    if (!tastyResult) return [];
    return includeOpenPositions
      ? [...tastyResult.trades, ...tastyResult.openPositions]
      : tastyResult.trades;
  }, [tastyResult, includeOpenPositions]);

  const buildPayloads = (): TradePayload[] => {
    if (tastyResult) {
      return tastyTrades.map((trade) => ({
        ticker: trade.ticker,
        type: trade.type,
        quantity: trade.quantity,
        strikePrice: trade.strikePrice,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice ?? undefined,
        entryTime: trade.entryTime,
        exitTime: trade.exitTime ?? undefined,
        expirationDate: trade.expirationDate,
        tradeDate: trade.tradeDate,
        pnl: trade.pnl ?? undefined,
        entryReason: describeEntry(trade),
        exitReason: describeExit(trade) || 'Position still open at time of import',
        timeClassification: classifyTimeOfDay(format(trade.entryTime, 'HH:mm')),
        direction: trade.direction,
        groupId: trade.groupId,
        strategyType: trade.strategyType,
        playbookId: 1,
      }));
    }

    // Parse selected date properly to avoid timezone shifts
    const [year, month, day] = selectedDate.split('-').map(Number);
    const tradeDate = new Date(year, month - 1, day); // month is 0-indexed
    const entryTime = new Date(year, month - 1, day, 9, 30, 0); // 9:30 AM CST
    const exitTime = new Date(year, month - 1, day, 10, 0, 0); // 10:00 AM CST

    return parsedTrades.map((trade) => ({
      ticker: trade.ticker,
      type: trade.type,
      quantity: trade.quantity,
      strikePrice: trade.strikePrice,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      entryTime,
      exitTime,
      expirationDate: new Date(trade.expirationDate),
      tradeDate,
      pnl: trade.pnl,
      entryReason: `Imported from E*TRADE (${trade.symbol})`,
      exitReason: "Imported trade",
      playbookId: 1, // Default to first strategy, user can edit later
    }));
  };

  const previewRows: PreviewRow[] = useMemo(() => {
    if (tastyResult) {
      return tastyTrades.map((trade) => ({
        ticker: trade.ticker,
        strategyType: trade.strategyType,
        type: trade.type,
        direction: trade.direction,
        quantity: trade.quantity,
        strikePrice: trade.strikePrice,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        pnl: trade.pnl,
        note: trade.closeKind === 'trade' ? '' : trade.closeKind,
      }));
    }

    return parsedTrades.map((trade) => ({
      ticker: trade.ticker,
      strategyType: '',
      type: trade.type,
      direction: null,
      quantity: trade.quantity,
      strikePrice: trade.strikePrice,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      pnl: trade.pnl,
      note: '',
    }));
  }, [tastyResult, tastyTrades, parsedTrades]);

  const detectedStrategies = useMemo(() => {
    // Counted per position rather than per leg, so a condor reads as one.
    const seenGroups = new Set<string>();
    const counts = new Map<string, number>();
    for (const trade of tastyTrades) {
      if (!trade.strategyType || seenGroups.has(trade.groupId)) continue;
      seenGroups.add(trade.groupId);
      counts.set(trade.strategyType, (counts.get(trade.strategyType) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [tastyTrades]);

  const closedBlockCount = useMemo(
    () => (tastyResult ? new Set(tastyResult.trades.map((trade) => trade.groupId)).size : 0),
    [tastyResult],
  );

  const netPnl = useMemo(
    () => (tastyResult ? tastyResult.trades.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0) : 0),
    [tastyResult],
  );
  const totalFees = useMemo(
    () => (tastyResult ? tastyResult.trades.reduce((sum, trade) => sum + trade.fees, 0) : 0),
    [tastyResult],
  );

  // Looks up the playbook entry for each detected position type, adding any that
  // are missing, so an import files its trades under the strategy they actually
  // are instead of all landing on one default entry.
  const resolveStrategyIds = async (names: string[]): Promise<Map<string, number>> => {
    const response = await apiRequest('/api/playbook-strategies', 'GET');
    const existing = (await response.json()) as { id: number; name: string }[];
    const byName = new Map(existing.map((strategy) => [strategy.name.toLowerCase(), strategy.id]));

    for (const name of names) {
      if (byName.has(name.toLowerCase())) continue;
      const created = await apiRequest('/api/playbook-strategies', 'POST', {
        name,
        description: 'Added automatically from an imported broker export.',
        isDefault: false,
      });
      const strategy = (await created.json()) as { id: number };
      byName.set(name.toLowerCase(), strategy.id);
    }

    return byName;
  };

  // Upload trades mutation
  const uploadTradesMutation = useMutation({
    mutationFn: async (payloads: TradePayload[]) => {
      const results = [];
      setIsUploading(true);
      setUploadProgress(0);

      const detected = Array.from(
        new Set(payloads.map((payload) => payload.strategyType).filter((name): name is string => !!name)),
      );
      let strategyIds = new Map<string, number>();
      if (detected.length > 0) {
        try {
          strategyIds = await resolveStrategyIds(detected);
        } catch (error) {
          // Filing under the right strategy is a convenience; losing it should
          // not cost the import.
          console.warn('Could not resolve playbook strategies for this import', error);
        }
      }

      for (let i = 0; i < payloads.length; i++) {
        const payload = payloads[i];
        const playbookId = payload.strategyType
          ? strategyIds.get(payload.strategyType.toLowerCase()) ?? payload.playbookId
          : payload.playbookId;
        try {
          const result = await apiRequest('/api/trades', 'POST', { ...payload, playbookId });
          results.push({ success: true, payload, result });
        } catch (error) {
          results.push({ success: false, payload, error });
        }

        setUploadProgress(((i + 1) / payloads.length) * 100);
      }

      return results;
    },
    onSuccess: (results) => {
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      queryClient.invalidateQueries({ queryKey: ['/api/trades'] });
      queryClient.invalidateQueries({ queryKey: ['/api/performance'] });
      queryClient.invalidateQueries({ queryKey: ['/api/performance/analytics'] });
      queryClient.invalidateQueries({ queryKey: ['/api/playbook-strategies'] });

      toast({
        title: "Upload Complete",
        description: `${successful} trades uploaded successfully${failed > 0 ? `, ${failed} failed` : ''}.`,
      });

      if (successful > 0) {
        onSuccess();
      }

      setIsUploading(false);
      setUploadProgress(0);
    },
    onError: () => {
      toast({
        title: "Upload Failed",
        description: "Failed to upload trades. Please try again.",
        variant: "destructive",
      });
      setIsUploading(false);
      setUploadProgress(0);
    },
  });

  const handleUpload = () => {
    const payloads = buildPayloads();
    if (payloads.length === 0) return;
    uploadTradesMutation.mutate(payloads);
  };

  return (
    <Card className="w-full max-w-4xl mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="w-5 h-5" />
          Bulk Trade Upload - tastytrade or E*TRADE
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Date Selection - tastytrade exports carry their own fill timestamps */}
        {!tastyResult && (
          <div className="space-y-2">
            <Label htmlFor="trade-date">Trade Date</Label>
            <Input
              id="trade-date"
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full"
            />
            <p className="text-sm text-gray-600">
              All imported E*TRADE trades will be assigned to this date
            </p>
          </div>
        )}

        {/* File Upload Zone */}
        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            isDragActive
              ? 'border-primary bg-primary/10'
              : 'border-muted-foreground/25 hover:border-primary/50'
          }`}
        >
          <input {...getInputProps()} />
          <FileText className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <p className="text-lg font-medium mb-2">
            {isDragActive ? 'Drop the file here' : 'Drag & drop your broker export here'}
          </p>
          <p className="text-sm text-muted-foreground">
            The format is detected automatically
          </p>
        </div>

        {/* Format Info */}
        {!tastyResult && parsedTrades.length === 0 && (
          <div className="bg-blue-50 dark:bg-blue-950/20 p-4 rounded-lg">
            <h4 className="font-semibold mb-2 flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              Supported Formats
            </h4>
            <div className="text-sm space-y-2">
              <div>
                <p className="font-medium">tastytrade — transaction history</p>
                <p className="text-xs text-muted-foreground">
                  History tab → CSV download. Opening and closing fills are matched FIFO into
                  round trips, one row per option leg, using the real fill times.
                </p>
              </div>
              <div>
                <p className="font-medium">E*TRADE — gains &amp; losses</p>
                <p className="text-xs text-muted-foreground">
                  Columns: Symbol, Basis/Share, Proceeds/Share, Quantity.
                  Symbol format: -SPY250703C618
                </p>
              </div>
            </div>
          </div>
        )}

        {/* tastytrade import summary and options */}
        {tastyResult && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-muted p-3 rounded-lg">
                <p className="text-xs text-muted-foreground">Closed legs</p>
                <p className="text-lg font-semibold">
                  {tastyResult.trades.length}
                  <span className="text-xs font-normal text-muted-foreground">
                    {' '}in {closedBlockCount} position{closedBlockCount === 1 ? '' : 's'}
                  </span>
                </p>
              </div>
              <div className="bg-muted p-3 rounded-lg">
                <p className="text-xs text-muted-foreground">Still open</p>
                <p className="text-lg font-semibold">{tastyResult.openPositions.length}</p>
              </div>
              <div className="bg-muted p-3 rounded-lg">
                <p className="text-xs text-muted-foreground">Realized P&amp;L</p>
                <p className={`text-lg font-semibold ${netPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  ${netPnl.toFixed(2)}
                </p>
              </div>
              <div className="bg-muted p-3 rounded-lg">
                <p className="text-xs text-muted-foreground">Fees included</p>
                <p className="text-lg font-semibold">${totalFees.toFixed(2)}</p>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Calendar date for each trade</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={tradeDateBasis === 'exit' ? 'default' : 'outline'}
                  onClick={() => handleBasisChange('exit')}
                >
                  Date closed
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={tradeDateBasis === 'entry' ? 'default' : 'outline'}
                  onClick={() => handleBasisChange('entry')}
                >
                  Date opened
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                Multi-day positions land on this date in the performance calendar.
              </p>
            </div>

            {detectedStrategies.length > 0 && (
              <div className="space-y-1">
                <Label>Strategies detected</Label>
                <div className="flex flex-wrap gap-2">
                  {detectedStrategies.map(([name, count]) => (
                    <Badge key={name} variant="outline">
                      {name} x{count}
                    </Badge>
                  ))}
                </div>
                <p className="text-sm text-muted-foreground">
                  Added to your playbook if missing, and each trade filed under its own.
                </p>
              </div>
            )}

            {tastyResult.openPositions.length > 0 && (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="include-open"
                  checked={includeOpenPositions}
                  onCheckedChange={(checked) => setIncludeOpenPositions(checked === true)}
                />
                <div>
                  <Label htmlFor="include-open" className="cursor-pointer">
                    Also import {tastyResult.openPositions.length} open position(s)
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Imported without an exit price or P&amp;L.
                  </p>
                </div>
              </div>
            )}

            {tastyResult.warnings.length > 0 && (
              <div className="bg-amber-50 dark:bg-amber-950/20 p-4 rounded-lg">
                <h4 className="font-semibold mb-2 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" />
                  Needs a look ({tastyResult.warnings.length})
                </h4>
                <ul className="text-xs space-y-1 max-h-32 overflow-y-auto">
                  {tastyResult.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Parsed Trades Preview */}
        {previewRows.length > 0 && (
          <div>
            <h4 className="font-semibold mb-4">
              Parsed Trades ({previewRows.length})
            </h4>
            <div className="max-h-64 overflow-y-auto border rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-muted sticky top-0">
                  <tr>
                    <th className="p-2 text-left">Symbol</th>
                    <th className="p-2 text-left">Type</th>
                    <th className="p-2 text-left">Strike</th>
                    <th className="p-2 text-left">Qty</th>
                    <th className="p-2 text-left">Entry</th>
                    <th className="p-2 text-left">Exit</th>
                    <th className="p-2 text-left">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, index) => (
                    <tr key={index} className="border-t">
                      <td className="p-2">
                        <div>{row.ticker}</div>
                        {row.strategyType && (
                          <div className="text-xs text-muted-foreground">{row.strategyType}</div>
                        )}
                        {row.note && (
                          <span className="text-xs text-muted-foreground">({row.note})</span>
                        )}
                      </td>
                      <td className="p-2">
                        <Badge variant={row.type === 'calls' ? 'default' : 'secondary'}>
                          {row.direction ? `${row.direction === 'long' ? 'Long' : 'Short'} ${row.type}` : row.type}
                        </Badge>
                      </td>
                      <td className="p-2">${row.strikePrice}</td>
                      <td className="p-2">{row.quantity}</td>
                      <td className="p-2">${row.entryPrice.toFixed(2)}</td>
                      <td className="p-2">{row.exitPrice === null ? '—' : `$${row.exitPrice.toFixed(2)}`}</td>
                      <td className={`p-2 ${row.pnl === null ? '' : row.pnl > 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {row.pnl === null ? '—' : `$${row.pnl.toFixed(0)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Upload Progress */}
        {isUploading && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Uploading trades...</span>
              <span className="text-sm text-muted-foreground">{uploadProgress.toFixed(0)}%</span>
            </div>
            <Progress value={uploadProgress} className="w-full" />
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-4 justify-end">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {previewRows.length > 0 && (
            <Button onClick={handleUpload} disabled={isUploading}>
              {isUploading ? 'Uploading...' : `Upload ${previewRows.length} Trades`}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Parsing and position matching for tastytrade transaction-history exports.
//
// A tastytrade export is a transaction log: one row per fill, plus rows for
// corporate actions and cash movements. Unlike the E*TRADE gain/loss export,
// a row is not a completed trade — round trips have to be rebuilt by matching
// opening fills against closing fills, FIFO, per option contract.

export type OptionType = "calls" | "puts";
export type Direction = "long" | "short";
export type CloseKind = "trade" | "expired" | "cash-settled" | "exercised" | "open";
export type TradeDateBasis = "exit" | "entry";

export interface TastytradeRow {
  time: Date;
  type: string;
  subType: string;
  action: string;
  symbol: string;
  instrumentType: string;
  description: string;
  value: number;
  quantity: number;
  averagePrice: number;
  multiplier: number;
  underlying: string;
  expiration: Date;
  strike: number;
  optionType: OptionType;
  orderNo: string;
  total: number;
}

export interface MatchedTrade {
  ticker: string;
  type: OptionType;
  direction: Direction;
  quantity: number;
  strikePrice: number;
  entryPrice: number;
  exitPrice: number | null;
  entryTime: Date;
  exitTime: Date | null;
  expirationDate: Date;
  tradeDate: Date;
  /** Net of commissions and fees, matching the cash that hit the account. */
  pnl: number | null;
  /** Before commissions and fees. */
  grossPnl: number | null;
  fees: number;
  symbol: string;
  entryOrder: string;
  exitOrder: string;
  closeKind: CloseKind;
  needsReview: boolean;
}

export interface MatchResult {
  trades: MatchedTrade[];
  openPositions: MatchedTrade[];
  warnings: string[];
  skippedRows: number;
}

// The journal classifies fills against Central-time market hours
// (see classifyTimeOfDay in trade-calculations.ts), and tastytrade stamps
// every row with the account's own offset, so fills are converted to Central
// wall-clock before being turned into the naive dates the journal stores.
const MARKET_TIME_ZONE = "America/Chicago";

const OPENING_ACTIONS: Record<string, Direction> = {
  BUY_TO_OPEN: "long",
  SELL_TO_OPEN: "short",
};

const CLOSING_ACTIONS: Record<string, Direction> = {
  SELL_TO_CLOSE: "long",
  BUY_TO_CLOSE: "short",
};

function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }

  cells.push(cell);
  return cells.map((value) => value.trim());
}

function detectDelimiter(headerLine: string): string {
  return headerLine.split("\t").length > headerLine.split(",").length ? "\t" : ",";
}

function parseNumber(value: string | undefined): number {
  if (!value) return 0;
  // Commissions and fees are written as "--" on corporate-action rows.
  const cleaned = value.replace(/[$,\s]/g, "");
  if (!cleaned || cleaned === "--") return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseTimestamp(value: string): Date | null {
  // tastytrade writes the offset without a colon (2026-06-24T15:07:36+0100),
  // which is outside the date-time format the spec requires engines to accept.
  const normalised = value.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const parsed = new Date(normalised);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function parseExpiration(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  // 6/24/26 or 06/24/2026
  const slashed = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (slashed) {
    const year = Number(slashed[3]);
    return new Date(year < 100 ? 2000 + year : year, Number(slashed[1]) - 1, Number(slashed[2]));
  }

  return null;
}

/** Converts an instant to a naive Date holding the market's wall-clock time. */
function toMarketWallClock(instant: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MARKET_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);

  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = part("hour");

  return new Date(
    part("year"),
    part("month") - 1,
    part("day"),
    hour === 24 ? 0 : hour,
    part("minute"),
    part("second"),
  );
}

function dateOnly(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function isTastytradeExport(content: string): boolean {
  const headerLine = content.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const header = headerLine.toLowerCase();
  return header.includes("sub type") && header.includes("underlying symbol");
}

export function parseTastytradeRows(content: string): { rows: TastytradeRow[]; skippedRows: number } {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error("The file is empty.");
  }

  const delimiter = detectDelimiter(lines[0]);
  const header = splitRow(lines[0], delimiter).map((name) => name.toLowerCase());
  const columnOf = (name: string) => header.indexOf(name.toLowerCase());

  const required = ["date", "type", "symbol", "value", "quantity", "average price"];
  const missing = required.filter((name) => columnOf(name) === -1);
  if (missing.length > 0) {
    throw new Error(`Not a tastytrade transaction history — missing column(s): ${missing.join(", ")}.`);
  }

  const index = {
    date: columnOf("date"),
    type: columnOf("type"),
    subType: columnOf("sub type"),
    action: columnOf("action"),
    symbol: columnOf("symbol"),
    instrumentType: columnOf("instrument type"),
    description: columnOf("description"),
    value: columnOf("value"),
    quantity: columnOf("quantity"),
    averagePrice: columnOf("average price"),
    multiplier: columnOf("multiplier"),
    underlying: columnOf("underlying symbol"),
    expiration: columnOf("expiration date"),
    strike: columnOf("strike price"),
    callOrPut: columnOf("call or put"),
    orderNo: columnOf("order #"),
    total: columnOf("total"),
  };

  const rows: TastytradeRow[] = [];
  let skippedRows = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitRow(lines[i], delimiter);
    const at = (column: number) => (column === -1 ? "" : cells[column] ?? "");

    // Cash movements, share trades and futures have no option legs to journal.
    if (at(index.instrumentType) !== "Equity Option") {
      skippedRows++;
      continue;
    }

    const time = parseTimestamp(at(index.date));
    const expiration = parseExpiration(at(index.expiration));
    const callOrPut = at(index.callOrPut).toUpperCase();
    const quantity = Math.abs(parseNumber(at(index.quantity)));

    if (!time || !expiration || (callOrPut !== "CALL" && callOrPut !== "PUT") || quantity === 0) {
      skippedRows++;
      continue;
    }

    const multiplier = parseNumber(at(index.multiplier)) || 100;

    rows.push({
      time,
      type: at(index.type),
      subType: at(index.subType),
      action: at(index.action).toUpperCase(),
      symbol: at(index.symbol),
      instrumentType: at(index.instrumentType),
      description: at(index.description),
      value: parseNumber(at(index.value)),
      quantity,
      averagePrice: parseNumber(at(index.averagePrice)),
      multiplier,
      underlying: at(index.underlying) || at(index.symbol).split(/\s+/)[0],
      expiration,
      strike: parseNumber(at(index.strike)),
      optionType: callOrPut === "CALL" ? "calls" : "puts",
      orderNo: at(index.orderNo),
      total: parseNumber(at(index.total)),
    });
  }

  return { rows, skippedRows };
}

interface OpenLot {
  row: TastytradeRow;
  direction: Direction;
  remaining: number;
  pricePerShare: number;
  valuePerContract: number;
  totalPerContract: number;
}

interface CloseEvent {
  time: Date;
  pricePerShare: number;
  valuePerContract: number;
  totalPerContract: number;
  orderNo: string;
  kind: CloseKind;
  needsReview: boolean;
}

function pricePerShare(row: { averagePrice: number; multiplier: number }): number {
  return Math.abs(row.averagePrice) / (row.multiplier || 100);
}

function buildTrade(
  lot: OpenLot,
  close: CloseEvent | null,
  quantity: number,
  basis: TradeDateBasis,
): MatchedTrade {
  // Value and Total are signed cash flows, so summing the open and close legs
  // gives P&L for either direction without a separate long/short branch.
  const grossPnl = close ? (lot.valuePerContract + close.valuePerContract) * quantity : null;
  const netPnl = close ? (lot.totalPerContract + close.totalPerContract) * quantity : null;
  const entryTime = toMarketWallClock(lot.row.time);
  const exitTime = close ? toMarketWallClock(close.time) : null;

  return {
    ticker: lot.row.underlying,
    type: lot.row.optionType,
    direction: lot.direction,
    quantity,
    strikePrice: lot.row.strike,
    entryPrice: lot.pricePerShare,
    exitPrice: close ? close.pricePerShare : null,
    entryTime,
    exitTime,
    expirationDate: lot.row.expiration,
    tradeDate: dateOnly(basis === "entry" || !exitTime ? entryTime : exitTime),
    pnl: netPnl === null ? null : round(netPnl),
    grossPnl: grossPnl === null ? null : round(grossPnl),
    fees: netPnl === null || grossPnl === null ? 0 : round(netPnl - grossPnl),
    symbol: lot.row.symbol,
    entryOrder: lot.row.orderNo,
    exitOrder: close ? close.orderNo : "",
    closeKind: close ? close.kind : "open",
    needsReview: close ? close.needsReview : false,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function describeContract(row: TastytradeRow): string {
  const expiry = row.expiration.toLocaleDateString("en-US");
  return `${row.underlying} ${expiry} ${row.strike} ${row.optionType === "calls" ? "Call" : "Put"}`;
}

/**
 * Rebuilds round trips from a transaction log by matching closing fills against
 * open lots FIFO. Each option leg becomes its own trade — the journal stores one
 * strike per row, so a spread arrives as one row per leg whose P&L sums to the
 * spread's P&L.
 */
export function matchTastytradeTrades(
  rows: TastytradeRow[],
  options: { tradeDateBasis?: TradeDateBasis } = {},
): MatchResult {
  const basis = options.tradeDateBasis ?? "exit";
  const chronological = [...rows].sort((a, b) => a.time.getTime() - b.time.getTime());

  const lotsBySymbol = new Map<string, OpenLot[]>();
  const trades: MatchedTrade[] = [];
  const warnings: string[] = [];
  let skippedRows = 0;

  const closeAgainstLots = (
    symbol: string,
    direction: Direction | null,
    quantity: number,
    close: CloseEvent,
    label: string,
  ) => {
    const queue = lotsBySymbol.get(symbol) ?? [];
    let unmatched = quantity;

    while (unmatched > 0) {
      const lot = direction ? queue.find((candidate) => candidate.direction === direction) : queue[0];
      if (!lot) break;

      const matched = Math.min(unmatched, lot.remaining);
      trades.push(buildTrade(lot, close, matched, basis));
      lot.remaining -= matched;
      unmatched -= matched;
      if (lot.remaining === 0) {
        queue.splice(queue.indexOf(lot), 1);
      }
    }

    if (unmatched > 0) {
      warnings.push(
        `${label}: ${unmatched} contract(s) closed with no matching open fill — the export probably starts mid-position.`,
      );
    }
  };

  for (let i = 0; i < chronological.length; i++) {
    const row = chronological[i];

    if (row.type === "Receive Deliver") {
      // Expiry writes several rows for one contract: a removal row carrying the
      // position and, when it settles in cash, a settlement row carrying the
      // money. Fold them into a single close.
      const group = [row];
      while (
        i + 1 < chronological.length &&
        chronological[i + 1].type === "Receive Deliver" &&
        chronological[i + 1].symbol === row.symbol &&
        chronological[i + 1].time.getTime() === row.time.getTime()
      ) {
        group.push(chronological[++i]);
      }

      const settlement = group.find((entry) => /cash settle/i.test(entry.subType));
      const removal = group.find((entry) => !/cash settle/i.test(entry.subType)) ?? group[0];
      const quantity = removal.quantity;
      const subTypes = group.map((entry) => entry.subType).join(" / ");
      const isExercised = group.some((entry) => /exercise|assign/i.test(entry.subType));

      closeAgainstLots(
        row.symbol,
        null,
        quantity,
        {
          time: row.time,
          pricePerShare: settlement ? pricePerShare(settlement) : 0,
          valuePerContract: group.reduce((sum, entry) => sum + entry.value, 0) / quantity,
          totalPerContract: group.reduce((sum, entry) => sum + entry.total, 0) / quantity,
          orderNo: "",
          kind: settlement ? "cash-settled" : isExercised ? "exercised" : "expired",
          // A physically settled exercise moves the position into shares, and
          // the share leg is not an option row, so the P&L needs a human look.
          needsReview: isExercised && !settlement,
        },
        `${describeContract(row)} (${subTypes})`,
      );
      continue;
    }

    const openingDirection = OPENING_ACTIONS[row.action];
    if (openingDirection) {
      const queue = lotsBySymbol.get(row.symbol) ?? [];
      queue.push({
        row,
        direction: openingDirection,
        remaining: row.quantity,
        pricePerShare: pricePerShare(row),
        valuePerContract: row.value / row.quantity,
        totalPerContract: row.total / row.quantity,
      });
      lotsBySymbol.set(row.symbol, queue);
      continue;
    }

    const closingDirection = CLOSING_ACTIONS[row.action];
    if (closingDirection) {
      closeAgainstLots(
        row.symbol,
        closingDirection,
        row.quantity,
        {
          time: row.time,
          pricePerShare: pricePerShare(row),
          valuePerContract: row.value / row.quantity,
          totalPerContract: row.total / row.quantity,
          orderNo: row.orderNo,
          kind: "trade",
          needsReview: false,
        },
        describeContract(row),
      );
      continue;
    }

    skippedRows++;
  }

  const openPositions: MatchedTrade[] = [];
  lotsBySymbol.forEach((queue) => {
    queue.forEach((lot) => {
      openPositions.push(buildTrade(lot, null, lot.remaining, basis));
    });
  });

  trades.sort((a, b) => (a.exitTime?.getTime() ?? 0) - (b.exitTime?.getTime() ?? 0));
  openPositions.sort((a, b) => a.entryTime.getTime() - b.entryTime.getTime());

  return { trades, openPositions, warnings, skippedRows };
}

export function parseTastytradeExport(
  content: string,
  options: { tradeDateBasis?: TradeDateBasis } = {},
): MatchResult {
  const { rows, skippedRows } = parseTastytradeRows(content);
  const result = matchTastytradeTrades(rows, options);
  return { ...result, skippedRows: result.skippedRows + skippedRows };
}

export function describeEntry(trade: MatchedTrade): string {
  const side = trade.direction === "long" ? "Bought" : "Sold";
  const order = trade.entryOrder ? ` (order ${trade.entryOrder})` : "";
  return `Imported from tastytrade — ${side} ${trade.quantity} ${trade.symbol.trim()} @ ${trade.entryPrice.toFixed(2)}${order}`;
}

export function describeExit(trade: MatchedTrade): string {
  if (trade.closeKind === "open") return "";
  if (trade.closeKind === "expired") return "Expired worthless";
  if (trade.closeKind === "exercised") return "Exercised/assigned — settled in shares, P&L needs review";
  if (trade.closeKind === "cash-settled") {
    return `Cash settled at ${trade.exitPrice?.toFixed(2)}`;
  }
  const side = trade.direction === "long" ? "Sold" : "Bought";
  const order = trade.exitOrder ? ` (order ${trade.exitOrder})` : "";
  return `${side} to close @ ${trade.exitPrice?.toFixed(2)}${order}`;
}

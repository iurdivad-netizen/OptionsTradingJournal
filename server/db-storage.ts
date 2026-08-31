import { and, desc, eq, gte, lt } from "drizzle-orm";
import { db } from "./db";
import type { IStorage } from "./storage";
import {
  intradayNotes,
  playbookStrategies,
  premarketAnalysis,
  settings,
  tradeAnalysis,
  trades,
  users,
  type InsertIntradayNote,
  type InsertPlaybookStrategy,
  type InsertPremarketAnalysis,
  type InsertTrade,
  type InsertTradeAnalysis,
  type IntradayNote,
  type PlaybookStrategy,
  type PremarketAnalysis,
  type Settings,
  type Trade,
  type TradeAnalysis,
  type UpsertUser,
  type User,
} from "@shared/schema";

/** The strategies a fresh journal starts with, matching the in-memory store. */
const DEFAULT_STRATEGIES: InsertPlaybookStrategy[] = [
  { name: "No Strategy", description: "No strategy assigned - needs categorization", isDefault: true },
  { name: "Pullback long off VWAP", description: "Long calls when price pulls back to VWAP with volume confirmation", isDefault: true },
  { name: "Short off Call Resistance", description: "Short puts when price rejects at call resistance level", isDefault: true },
  { name: "Long off Resistance", description: "Long calls when price breaks above resistance with volume", isDefault: true },
  { name: "Long off Put Support", description: "Long calls when price bounces off put support with volume", isDefault: true },
  { name: "Short off Put Support", description: "Short puts when price breaks below put support level", isDefault: true },
];

/** Start of the day a timestamp falls on, and the start of the day after it. */
function dayBounds(date: Date): [Date, Date] {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start, end];
}

/**
 * PostgreSQL-backed storage. Used whenever DATABASE_URL is set; without one the
 * app falls back to the in-memory store, which keeps it runnable with no setup
 * but loses everything on restart.
 */
export class DbStorage implements IStorage {
  private get database() {
    if (!db) throw new Error("DATABASE_URL is not configured");
    return db;
  }

  /**
   * Checks the database actually has the columns this version reads.
   *
   * Pulling a change that adds a column without re-running db:push leaves a
   * database the queries fail against, and the failure is close to invisible:
   * the strategy list still loads while every trade query returns 500, so the
   * playbook renders every strategy with no trades rather than an error.
   */
  async describeSchemaProblem(): Promise<string | null> {
    try {
      await this.database.select().from(trades).limit(1);
      await this.database.select().from(playbookStrategies).limit(1);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return message;
    }
  }

  /**
   * Gives a journal that has none yet the same starting point as the in-memory
   * store: the default strategies and an opening account balance. Without the
   * balance the performance section has no starting equity and the client asks
   * for a setting that is not there.
   */
  async seedIfEmpty(): Promise<void> {
    const existing = await this.database.select().from(playbookStrategies).limit(1);
    if (existing.length === 0) {
      await this.database.insert(playbookStrategies).values(DEFAULT_STRATEGIES);
    }

    const balance = await this.getSetting("account_balance");
    if (!balance) {
      await this.setSetting("account_balance", "25000");
    }
  }

  // Users
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await this.database.select().from(users).where(eq(users.id, id));
    return user;
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    const [user] = await this.database
      .insert(users)
      .values(userData)
      .onConflictDoUpdate({
        target: users.id,
        set: { ...userData, updatedAt: new Date() },
      })
      .returning();
    return user;
  }

  // Trades
  async getTrades(): Promise<Trade[]> {
    return this.database.select().from(trades).orderBy(desc(trades.id));
  }

  async getTrade(id: number): Promise<Trade | undefined> {
    const [trade] = await this.database.select().from(trades).where(eq(trades.id, id));
    return trade;
  }

  async getTradesByDate(date: Date): Promise<Trade[]> {
    const [start, end] = dayBounds(date);
    return this.database
      .select()
      .from(trades)
      .where(and(gte(trades.tradeDate, start), lt(trades.tradeDate, end)));
  }

  async createTrade(trade: InsertTrade): Promise<Trade> {
    // Same rule as the in-memory store: the prices are only used when the
    // caller did not supply a P&L, since that calculation assumes a long
    // position and ignores fees.
    let pnl = trade.pnl ?? null;
    if (pnl === null && trade.exitPrice != null && trade.entryPrice != null) {
      pnl = (trade.exitPrice - trade.entryPrice) * trade.quantity * 100;
    }

    const [created] = await this.database
      .insert(trades)
      .values({ ...trade, pnl })
      .returning();
    return created;
  }

  async updateTrade(id: number, update: Partial<InsertTrade>): Promise<Trade | undefined> {
    const existing = await this.getTrade(id);
    if (!existing) return undefined;

    const merged = { ...existing, ...update };
    let pnl = merged.pnl;
    const priceChanged = update.entryPrice !== undefined || update.exitPrice !== undefined;
    if (update.pnl === undefined && priceChanged && merged.exitPrice != null && merged.entryPrice != null) {
      pnl = (merged.exitPrice - merged.entryPrice) * merged.quantity * 100;
    }

    const [updated] = await this.database
      .update(trades)
      .set({ ...update, pnl })
      .where(eq(trades.id, id))
      .returning();
    return updated;
  }

  async deleteTrade(id: number): Promise<boolean> {
    const deleted = await this.database.delete(trades).where(eq(trades.id, id)).returning();
    return deleted.length > 0;
  }

  // Premarket analysis
  async getPremarketAnalysis(): Promise<PremarketAnalysis[]> {
    return this.database.select().from(premarketAnalysis).orderBy(desc(premarketAnalysis.date));
  }

  async getPremarketAnalysisByDate(date: Date): Promise<PremarketAnalysis | undefined> {
    const [start, end] = dayBounds(date);
    const [found] = await this.database
      .select()
      .from(premarketAnalysis)
      .where(and(gte(premarketAnalysis.date, start), lt(premarketAnalysis.date, end)));
    return found;
  }

  async createPremarketAnalysis(analysis: InsertPremarketAnalysis): Promise<PremarketAnalysis> {
    const [created] = await this.database.insert(premarketAnalysis).values(analysis).returning();
    return created;
  }

  async updatePremarketAnalysis(
    id: number,
    analysis: Partial<InsertPremarketAnalysis>,
  ): Promise<PremarketAnalysis | undefined> {
    const [updated] = await this.database
      .update(premarketAnalysis)
      .set(analysis)
      .where(eq(premarketAnalysis.id, id))
      .returning();
    return updated;
  }

  // Trade analysis
  async getTradeAnalyses(): Promise<TradeAnalysis[]> {
    return this.database.select().from(tradeAnalysis);
  }

  async getTradeAnalysis(tradeId: number): Promise<TradeAnalysis | undefined> {
    const [found] = await this.database
      .select()
      .from(tradeAnalysis)
      .where(eq(tradeAnalysis.tradeId, tradeId));
    return found;
  }

  async createTradeAnalysis(analysis: InsertTradeAnalysis): Promise<TradeAnalysis> {
    const [created] = await this.database.insert(tradeAnalysis).values(analysis).returning();
    return created;
  }

  async updateTradeAnalysis(
    id: number,
    analysis: Partial<InsertTradeAnalysis>,
  ): Promise<TradeAnalysis | undefined> {
    const [updated] = await this.database
      .update(tradeAnalysis)
      .set(analysis)
      .where(eq(tradeAnalysis.id, id))
      .returning();
    return updated;
  }

  // Playbook strategies
  async getPlaybookStrategies(): Promise<PlaybookStrategy[]> {
    return this.database.select().from(playbookStrategies).orderBy(playbookStrategies.id);
  }

  async createPlaybookStrategy(strategy: InsertPlaybookStrategy): Promise<PlaybookStrategy> {
    const [created] = await this.database.insert(playbookStrategies).values(strategy).returning();
    return created;
  }

  async updatePlaybookStrategy(
    id: number,
    strategy: Partial<InsertPlaybookStrategy>,
  ): Promise<PlaybookStrategy | undefined> {
    const [updated] = await this.database
      .update(playbookStrategies)
      .set(strategy)
      .where(eq(playbookStrategies.id, id))
      .returning();
    return updated;
  }

  async deletePlaybookStrategy(id: number): Promise<boolean> {
    const deleted = await this.database
      .delete(playbookStrategies)
      .where(eq(playbookStrategies.id, id))
      .returning();
    return deleted.length > 0;
  }

  // Intraday notes
  async getIntradayNotes(): Promise<IntradayNote[]> {
    return this.database.select().from(intradayNotes).orderBy(desc(intradayNotes.time));
  }

  async getIntradayNotesByDate(date: Date): Promise<IntradayNote[]> {
    const [start, end] = dayBounds(date);
    return this.database
      .select()
      .from(intradayNotes)
      .where(and(gte(intradayNotes.date, start), lt(intradayNotes.date, end)));
  }

  async createIntradayNote(note: InsertIntradayNote): Promise<IntradayNote> {
    const [created] = await this.database.insert(intradayNotes).values(note).returning();
    return created;
  }

  async updateIntradayNote(
    id: number,
    note: Partial<InsertIntradayNote>,
  ): Promise<IntradayNote | undefined> {
    const [updated] = await this.database
      .update(intradayNotes)
      .set(note)
      .where(eq(intradayNotes.id, id))
      .returning();
    return updated;
  }

  async deleteIntradayNote(id: number): Promise<boolean> {
    const deleted = await this.database
      .delete(intradayNotes)
      .where(eq(intradayNotes.id, id))
      .returning();
    return deleted.length > 0;
  }

  // Everything else
  async clearAllData(): Promise<boolean> {
    // Analyses reference trades, so they go first.
    await this.database.delete(tradeAnalysis);
    await this.database.delete(trades);
    await this.database.delete(premarketAnalysis);
    await this.database.delete(intradayNotes);
    return true;
  }

  async getSetting(key: string): Promise<Settings | undefined> {
    const [found] = await this.database.select().from(settings).where(eq(settings.key, key));
    return found;
  }

  async setSetting(key: string, value: string): Promise<Settings> {
    const [saved] = await this.database
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      })
      .returning();
    return saved;
  }
}

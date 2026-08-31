import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { statsFromLegs } from "@shared/positions";
import { getSession, authenticate, login, logout, getUser } from "./auth";
import { insertTradeSchema, insertPremarketAnalysisSchema, insertTradeAnalysisSchema, insertPlaybookStrategySchema, insertIntradayNoteSchema } from "@shared/schema";

export async function registerRoutes(app: Express): Promise<Server> {
  // Session middleware
  app.use(getSession());

  // Authentication routes (public)
  app.post("/api/auth/login", login);
  app.post("/api/auth/logout", logout);
  app.get("/api/auth/user", getUser);

  // Protected routes - all API routes below require authentication
  // Trades routes
  app.get("/api/trades", authenticate, async (req, res) => {
    try {
      const trades = await storage.getTrades();
      res.json(trades);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch trades" });
    }
  });

  app.get("/api/trades/date/:date", async (req, res) => {
    try {
      const date = new Date(req.params.date);
      const trades = await storage.getTradesByDate(date);
      res.json(trades);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch trades by date" });
    }
  });

  app.get("/api/trades/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const trade = await storage.getTrade(id);
      if (!trade) {
        return res.status(404).json({ message: "Trade not found" });
      }
      res.json(trade);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch trade" });
    }
  });

  app.post("/api/trades", async (req, res) => {
    try {
      const validatedData = insertTradeSchema.parse(req.body);
      const trade = await storage.createTrade(validatedData);
      res.status(201).json(trade);
    } catch (error) {
      res.status(400).json({ message: "Invalid trade data", error });
    }
  });

  app.patch("/api/trades/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updateData = insertTradeSchema.partial().parse(req.body);
      const trade = await storage.updateTrade(id, updateData);
      if (!trade) {
        return res.status(404).json({ message: "Trade not found" });
      }
      res.json(trade);
    } catch (error) {
      res.status(400).json({ message: "Invalid update data", error });
    }
  });

  app.delete("/api/trades/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteTrade(id);
      if (!deleted) {
        return res.status(404).json({ message: "Trade not found" });
      }
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: "Failed to delete trade" });
    }
  });

  // Premarket Analysis routes
  app.get("/api/premarket-analysis", async (req, res) => {
    try {
      const analyses = await storage.getPremarketAnalysis();
      res.json(analyses);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch premarket analyses" });
    }
  });

  app.get("/api/premarket-analysis/today", async (req, res) => {
    try {
      const today = new Date();
      const analysis = await storage.getPremarketAnalysisByDate(today);
      res.json(analysis || null);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch today's analysis" });
    }
  });

  app.post("/api/premarket-analysis", async (req, res) => {
    try {
      const validatedData = insertPremarketAnalysisSchema.parse(req.body);
      const analysis = await storage.createPremarketAnalysis(validatedData);
      res.status(201).json(analysis);
    } catch (error) {
      res.status(400).json({ message: "Invalid premarket analysis data", error });
    }
  });

  app.patch("/api/premarket-analysis/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updateData = insertPremarketAnalysisSchema.partial().parse(req.body);
      const analysis = await storage.updatePremarketAnalysis(id, updateData);
      if (!analysis) {
        return res.status(404).json({ message: "Premarket analysis not found" });
      }
      res.json(analysis);
    } catch (error) {
      res.status(400).json({ message: "Invalid update data", error });
    }
  });

  // Trade Analysis routes
  app.get("/api/trade-analysis", async (req, res) => {
    try {
      const analyses = await storage.getTradeAnalyses();
      res.json(analyses);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch trade analyses" });
    }
  });

  app.get("/api/trade-analysis/trade/:tradeId", async (req, res) => {
    try {
      const tradeId = parseInt(req.params.tradeId);
      const analysis = await storage.getTradeAnalysis(tradeId);
      res.json(analysis || null);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch trade analysis" });
    }
  });

  app.post("/api/trade-analysis", async (req, res) => {
    try {
      const validatedData = insertTradeAnalysisSchema.parse(req.body);
      const analysis = await storage.createTradeAnalysis(validatedData);
      res.status(201).json(analysis);
    } catch (error) {
      res.status(400).json({ message: "Invalid trade analysis data", error });
    }
  });

  app.patch("/api/trade-analysis/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updateData = insertTradeAnalysisSchema.partial().parse(req.body);
      const analysis = await storage.updateTradeAnalysis(id, updateData);
      if (!analysis) {
        return res.status(404).json({ message: "Trade analysis not found" });
      }
      res.json(analysis);
    } catch (error) {
      res.status(400).json({ message: "Invalid update data", error });
    }
  });

  // Playbook Strategies routes
  app.get("/api/playbook-strategies", async (req, res) => {
    try {
      const strategies = await storage.getPlaybookStrategies();
      res.json(strategies);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch playbook strategies" });
    }
  });

  app.post("/api/playbook-strategies", async (req, res) => {
    try {
      const validatedData = insertPlaybookStrategySchema.parse(req.body);
      const strategy = await storage.createPlaybookStrategy(validatedData);
      res.status(201).json(strategy);
    } catch (error) {
      res.status(400).json({ message: "Invalid strategy data", error });
    }
  });

  app.patch("/api/playbook-strategies/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updateData = insertPlaybookStrategySchema.partial().parse(req.body);
      const strategy = await storage.updatePlaybookStrategy(id, updateData);
      if (!strategy) {
        return res.status(404).json({ message: "Strategy not found" });
      }
      res.json(strategy);
    } catch (error) {
      res.status(400).json({ message: "Invalid update data", error });
    }
  });

  app.delete("/api/playbook-strategies/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deletePlaybookStrategy(id);
      if (!deleted) {
        return res.status(404).json({ message: "Strategy not found or cannot be deleted" });
      }
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: "Failed to delete strategy" });
    }
  });

  // Performance Analytics route
  app.get("/api/performance/analytics", async (req, res) => {
    try {
      const trades = await storage.getTrades();
      
      // Calculate performance metrics. Win rate and the averages are counted
      // per position, so a four-leg condor is one win or one loss rather than
      // two of each; the money totals stay on legs, which sum to the same figure.
      const completedTrades = trades.filter(t => t.pnl !== null);
      const stats = statsFromLegs(trades);

      const totalTrades = stats.positions;
      const totalPnL = completedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
      const winRate = stats.winRate;
      const avgWin = stats.avgWin;
      const avgLoss = stats.avgLoss;
      const avgRR = stats.avgRR;
      
      // Performance by symbol
      const symbolPerformance = trades.reduce((acc, trade) => {
        if (trade.pnl !== null) {
          acc[trade.ticker] = (acc[trade.ticker] || 0) + trade.pnl;
        }
        return acc;
      }, {} as Record<string, number>);
      
      // Performance by time classification
      const timePerformance = trades.reduce((acc, trade) => {
        if (trade.pnl !== null && trade.timeClassification) {
          acc[trade.timeClassification] = (acc[trade.timeClassification] || 0) + trade.pnl;
        }
        return acc;
      }, {} as Record<string, number>);
      
      // Daily P&L, keyed in date order. Trades are listed newest first, and an
      // object keeps its keys in insertion order, so building this straight from
      // that list would hand the client its days backwards.
      const dailyPnL = [...trades]
        .filter(trade => trade.pnl !== null && trade.tradeDate)
        .sort((a, b) => a.tradeDate.getTime() - b.tradeDate.getTime())
        .reduce((acc, trade) => {
          const date = trade.tradeDate.toDateString();
          acc[date] = (acc[date] || 0) + trade.pnl!;
          return acc;
        }, {} as Record<string, number>);

      res.json({
        totalPnL,
        winRate,
        avgRR,
        avgWin,
        avgLoss,
        totalTrades,
        totalLegs: trades.length,
        winningPositions: stats.wins,
        losingPositions: stats.losses,
        completedPositions: stats.completed,
        symbolPerformance,
        timePerformance,
        dailyPnL,
        trades: completedTrades
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to calculate performance analytics" });
    }
  });

  // Intraday Notes routes
  app.get("/api/intraday-notes", async (req, res) => {
    try {
      const notes = await storage.getIntradayNotes();
      res.json(notes);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch intraday notes" });
    }
  });

  app.get("/api/intraday-notes/today", async (req, res) => {
    try {
      const today = new Date();
      const notes = await storage.getIntradayNotesByDate(today);
      res.json(notes);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch today's notes" });
    }
  });

  app.post("/api/intraday-notes", async (req, res) => {
    try {
      const validatedData = insertIntradayNoteSchema.parse(req.body);
      const note = await storage.createIntradayNote(validatedData);
      res.status(201).json(note);
    } catch (error) {
      res.status(400).json({ message: "Invalid note data", error });
    }
  });

  app.patch("/api/intraday-notes/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updateData = insertIntradayNoteSchema.partial().parse(req.body);
      const note = await storage.updateIntradayNote(id, updateData);
      if (!note) {
        return res.status(404).json({ message: "Note not found" });
      }
      res.json(note);
    } catch (error) {
      res.status(400).json({ message: "Invalid update data", error });
    }
  });

  app.delete("/api/intraday-notes/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteIntradayNote(id);
      if (!deleted) {
        return res.status(404).json({ message: "Note not found" });
      }
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: "Failed to delete note" });
    }
  });

  // Settings routes
  app.get("/api/settings/:key", async (req, res) => {
    try {
      const { key } = req.params;
      const setting = await storage.getSetting(key);
      if (!setting) {
        return res.status(404).json({ message: "Setting not found" });
      }
      res.json(setting);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch setting" });
    }
  });

  app.put("/api/settings/:key", async (req, res) => {
    try {
      const { key } = req.params;
      const { value } = req.body;
      if (!value) {
        return res.status(400).json({ message: "Value is required" });
      }
      const setting = await storage.setSetting(key, value);
      res.json(setting);
    } catch (error) {
      res.status(500).json({ message: "Failed to update setting" });
    }
  });

  // Clear all data endpoint
  app.post("/api/clear-data", async (req, res) => {
    try {
      const success = await storage.clearAllData();
      if (success) {
        res.json({ message: "All data cleared successfully" });
      } else {
        res.status(500).json({ message: "Failed to clear data" });
      }
    } catch (error) {
      res.status(500).json({ message: "Failed to clear data" });
    }
  });

  // Export data endpoints
  app.get("/api/export/trades", async (req, res) => {
    try {
      const trades = await storage.getTrades();
      res.json(trades);
    } catch (error) {
      res.status(500).json({ message: "Failed to export trades" });
    }
  });

  app.get("/api/export/performance-csv", async (req, res) => {
    try {
      const trades = await storage.getTrades();
      
      // Create CSV header
      const csvHeader = "Date,Ticker,Type,Quantity,Entry,Exit,PnL,Strategy,Notes\n";
      
      // Create CSV rows
      const csvRows = trades.map(trade => {
        const date = new Date(trade.entryTime).toLocaleDateString();
        const pnl = trade.pnl || 0;
        const strategy = trade.entryReason || "";
        const notes = (trade.exitReason || "").replace(/"/g, '""'); // Escape quotes
        
        return `${date},"${trade.ticker}","${trade.type}",${trade.quantity},${trade.entryPrice},${trade.exitPrice || ""},${pnl},"${strategy}","${notes}"`;
      }).join("\n");
      
      const csvContent = csvHeader + csvRows;
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="trades-export.csv"');
      res.send(csvContent);
    } catch (error) {
      res.status(500).json({ message: "Failed to export trades CSV" });
    }
  });

  app.get("/api/export/analysis-csv", async (req, res) => {
    try {
      const analyses = await storage.getTradeAnalyses();
      
      // Create CSV header
      const csvHeader = "Trade ID,What Went Well,What Went Wrong,Key Learnings,Emotional State,Market Conditions,Improvements\n";
      
      // Create CSV rows
      const csvRows = analyses.map(analysis => {
        const escapeField = (field: string) => (field || "").replace(/"/g, '""');
        
        return `${analysis.tradeId},"${escapeField(analysis.whatWentWell || "")}","${escapeField(analysis.whatToImprove || "")}","${escapeField(analysis.nextTime || "")}","","","${escapeField(analysis.whatToImprove || "")}"`;
      }).join("\n");
      
      const csvContent = csvHeader + csvRows;
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="analysis-export.csv"');
      res.send(csvContent);
    } catch (error) {
      res.status(500).json({ message: "Failed to export analysis CSV" });
    }
  });

  app.get("/api/export/performance-report", async (req, res) => {
    try {
      const trades = await storage.getTrades();
      const analyses = await storage.getTradeAnalyses();
      
      // Calculate performance metrics
      // Counted per position rather than per leg, so a spread reports as the
      // one trade it was rather than as several.
      const stats = statsFromLegs(trades);
      const totalTrades = stats.positions;
      const winningTrades = stats.wins;
      const losingTrades = stats.losses;
      const totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
      const winRate = stats.completed > 0 ? stats.winRate.toFixed(1) : "0";
      const avgWin = stats.avgWin.toFixed(2);
      const avgLoss = (-stats.avgLoss).toFixed(2);
      
      const report = {
        reportDate: new Date().toISOString(),
        summary: {
          totalTrades,
          winningTrades,
          losingTrades,
          totalPnL: totalPnL.toFixed(2),
          winRate: `${winRate}%`,
          avgWin,
          avgLoss
        },
        trades,
        analyses
      };
      
      res.json(report);
    } catch (error) {
      res.status(500).json({ message: "Failed to generate performance report" });
    }
  });

  // Database backup endpoint
  app.post("/api/backup", async (req, res) => {
    try {
      const trades = await storage.getTrades();
      const strategies = await storage.getPlaybookStrategies();
      const analyses = await storage.getTradeAnalyses();
      const premarketAnalyses = await storage.getPremarketAnalysis();
      const intradayNotes = await storage.getIntradayNotes();
      
      const backup = {
        timestamp: new Date().toISOString(),
        version: "1.0",
        data: {
          trades,
          strategies,
          analyses,
          premarketAnalyses,
          intradayNotes
        }
      };
      
      res.json(backup);
    } catch (error) {
      res.status(500).json({ message: "Failed to create backup" });
    }
  });

  // Import data endpoint
  app.post("/api/import-data", async (req, res) => {
    try {
      const importData = req.body;
      
      // Validate the imported data structure
      if (!importData.trades || !Array.isArray(importData.trades)) {
        return res.status(400).json({ message: "Invalid data format" });
      }

      // Clear existing data first
      await storage.clearAllData();
      
      // Import trades
      for (const trade of importData.trades) {
        try {
          const validatedTrade = insertTradeSchema.parse(trade);
          await storage.createTrade(validatedTrade);
        } catch (error) {
          console.warn("Failed to import trade:", error);
        }
      }

      // Import strategies if available
      if (importData.strategies && Array.isArray(importData.strategies)) {
        for (const strategy of importData.strategies) {
          try {
            const validatedStrategy = insertPlaybookStrategySchema.parse(strategy);
            await storage.createPlaybookStrategy(validatedStrategy);
          } catch (error) {
            console.warn("Failed to import strategy:", error);
          }
        }
      }

      // Import analyses if available
      if (importData.analyses && Array.isArray(importData.analyses)) {
        for (const analysis of importData.analyses) {
          try {
            const validatedAnalysis = insertTradeAnalysisSchema.parse(analysis);
            await storage.createTradeAnalysis(validatedAnalysis);
          } catch (error) {
            console.warn("Failed to import analysis:", error);
          }
        }
      }

      res.json({ message: "Data imported successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to import data", error: error.message });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

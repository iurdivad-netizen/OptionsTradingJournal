// Grouping legs back into the positions they were traded as.
//
// A multi-leg options position is stored as one row per leg, so counting rows
// answers the wrong question: every vertical contributes one winning leg and one
// losing leg by construction, which drags any win rate toward 50% and inflates
// the average win with the profitable half of a losing spread. Statistics that
// count trades therefore have to count positions, while statistics that add up
// money can keep working from legs, since the two sums are identical.

export interface LegLike {
  id: number;
  groupId?: string | null;
  pnl?: number | null;
  playbookId?: number | null;
}

export interface Position<T extends LegLike> {
  key: string;
  legs: T[];
  /** Total across the legs, or null while any leg is still open. */
  pnl: number | null;
}

export interface PositionStats {
  positions: number;
  completed: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  avgRR: number;
}

/**
 * Groups legs by the broker order that opened them. A leg with no group — a
 * manually entered trade, or an import that predates grouping — stands alone,
 * so single-leg trades behave exactly as they did before.
 */
export function groupIntoPositions<T extends LegLike>(legs: T[]): Position<T>[] {
  const positions: Position<T>[] = [];
  const indexByGroup = new Map<string, number>();

  for (const leg of legs) {
    if (!leg.groupId) {
      positions.push({ key: `trade-${leg.id}`, legs: [leg], pnl: null });
      continue;
    }

    const existing = indexByGroup.get(leg.groupId);
    if (existing === undefined) {
      indexByGroup.set(leg.groupId, positions.length);
      positions.push({ key: leg.groupId, legs: [leg], pnl: null });
    } else {
      positions[existing].legs.push(leg);
    }
  }

  for (const position of positions) {
    // A position is only a win or a loss once every leg of it is closed.
    const open = position.legs.some((leg) => leg.pnl === null || leg.pnl === undefined);
    position.pnl = open
      ? null
      : position.legs.reduce((sum, leg) => sum + (leg.pnl ?? 0), 0);
  }

  return positions;
}

export function summarisePositions<T extends LegLike>(positions: Position<T>[]): PositionStats {
  const completed = positions.filter((position) => position.pnl !== null);
  const wins = completed.filter((position) => position.pnl! > 0);
  const losses = completed.filter((position) => position.pnl! <= 0);

  const avgWin = wins.length > 0
    ? wins.reduce((sum, position) => sum + position.pnl!, 0) / wins.length
    : 0;
  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((sum, position) => sum + position.pnl!, 0) / losses.length)
    : 0;

  return {
    positions: positions.length,
    completed: completed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: completed.length > 0 ? (wins.length / completed.length) * 100 : 0,
    avgWin,
    avgLoss,
    avgRR: avgLoss > 0 ? avgWin / avgLoss : 0,
  };
}

/** Convenience for the common "legs in, statistics out" path. */
export function statsFromLegs<T extends LegLike>(legs: T[]): PositionStats {
  return summarisePositions(groupIntoPositions(legs));
}

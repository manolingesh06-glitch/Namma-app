// src/analytics.js
// -----------------------------------------------------------------------
// Pure read-only aggregate queries. Nothing here is ever called from
// auctionEngine.js, so no analytics query can add latency to a bid —
// these only run when a client explicitly requests them (e.g. opening
// an Analytics tab), and SQLite's WAL mode (enabled in db.js) lets these
// reads happen concurrently with bid writes without blocking either side.

import { db } from "./db.js";

function soldStats(auctionId) {
  return db
    .prepare(
      `SELECT COUNT(*) as soldCount, COALESCE(SUM(sold_price),0) as totalSpending,
              COALESCE(MAX(sold_price),0) as highestPurchase, COALESCE(MIN(sold_price),0) as lowestPurchase,
              COALESCE(AVG(sold_price),0) as averagePurchase
       FROM players WHERE auction_id = ? AND status = 'SOLD'`
    )
    .get(auctionId);
}

function categoryStats(auctionId) {
  return db
    .prepare(
      `SELECT category, COUNT(*) as count, COALESCE(SUM(sold_price),0) as totalSpent, COALESCE(AVG(sold_price),0) as avgPrice
       FROM players WHERE auction_id = ? AND status = 'SOLD' AND category IS NOT NULL
       GROUP BY category`
    )
    .all(auctionId);
}

function teamBreakdown(auctionId) {
  return db
    .prepare(
      `SELECT id, name, purse, spent, (purse - spent) as remaining, squad_count, squad_limit, overseas_count, overseas_limit
       FROM teams WHERE auction_id = ? ORDER BY spent DESC`
    )
    .all(auctionId);
}

export function getLiveAnalytics(auctionId) {
  const sold = soldStats(auctionId);
  const unsoldCount = db.prepare("SELECT COUNT(*) as c FROM players WHERE auction_id = ? AND status = 'UNSOLD'").get(auctionId).c;
  const totalBids = db.prepare("SELECT COUNT(*) as c FROM audit_log WHERE auction_id = ? AND type = 'BID_ACCEPTED'").get(auctionId).c;

  return {
    totalBids,
    soldCount: sold.soldCount,
    unsoldCount,
    totalSpending: sold.totalSpending,
    highestPurchase: sold.highestPurchase,
    averagePurchase: Math.round(sold.averagePurchase),
    teams: teamBreakdown(auctionId),
    categoryStats: categoryStats(auctionId),
  };
}

export function getFinalAnalytics(auctionId) {
  const sold = soldStats(auctionId);
  const unsoldCount = db.prepare("SELECT COUNT(*) as c FROM players WHERE auction_id = ? AND status = 'UNSOLD'").get(auctionId).c;
  const totalBids = db.prepare("SELECT COUNT(*) as c FROM audit_log WHERE auction_id = ? AND type = 'BID_ACCEPTED'").get(auctionId).c;
  const totalDecided = sold.soldCount + unsoldCount;

  return {
    bidCount: totalBids,
    soldCount: sold.soldCount,
    unsoldCount,
    unsoldPercentage: totalDecided > 0 ? Math.round((unsoldCount / totalDecided) * 100) : 0,
    highestPurchase: sold.highestPurchase,
    lowestPurchase: sold.soldCount > 0 ? sold.lowestPurchase : 0,
    averagePurchase: Math.round(sold.averagePurchase),
    totalSpending: sold.totalSpending,
    teamComparison: teamBreakdown(auctionId),
    categoryStats: categoryStats(auctionId),
  };
}

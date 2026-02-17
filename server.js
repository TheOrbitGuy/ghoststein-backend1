// GHOSTSTEIN Aviator - Bulletproof Backend
// Protection against spam, double-clicks, and duplicate requests

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ============================================
// STORAGE
// ============================================
const users    = new Map(); // userId → user object
const games    = new Map(); // gameId → game object
const activeGames = new Map(); // userId → gameId (only ONE per user!)

// ============================================
// RATE LIMITER (no extra package needed!)
// ============================================
const requestLog = new Map(); // userId → { count, resetAt }

function isRateLimited(userId, maxPerMinute = 30) {
  const now = Date.now();
  const entry = requestLog.get(userId);

  if (!entry || now > entry.resetAt) {
    // Fresh window
    requestLog.set(userId, { count: 1, resetAt: now + 60000 });
    return false;
  }

  if (entry.count >= maxPerMinute) {
    return true; // Too many requests!
  }

  entry.count++;
  return false;
}

// ============================================
// USER HELPER
// ============================================
function getUser(userId) {
  if (!users.has(userId)) {
    users.set(userId, {
      userId,
      balance: 0,
      gamesPlayed: 0,
      totalWon: 0,
      totalWagered: 0,
      lastGameAt: 0,   // timestamp of last game start
    });
  }
  return users.get(userId);
}

// ============================================
// CRASH POINT GENERATOR (fair + capped at 20x)
// ============================================
function generateCrashPoint() {
  const r = Math.random();
  if (r < 0.35) return parseFloat((1.00 + Math.random() * 0.70).toFixed(2));
  if (r < 0.60) return parseFloat((1.70 + Math.random() * 0.80).toFixed(2));
  if (r < 0.80) return parseFloat((2.50 + Math.random() * 2.50).toFixed(2));
  if (r < 0.93) return parseFloat((5.00 + Math.random() * 5.00).toFixed(2));
  return parseFloat((10.0 + Math.random() * 10.0).toFixed(2));
}

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({ name: 'GHOSTSTEIN Aviator', status: 'online', version: '2.0' });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'operational',
    users: users.size,
    activeGames: activeGames.size,
    timestamp: new Date().toISOString()
  });
});

// ── GET USER ──────────────────────────────────
app.get('/api/user/:userId', (req, res) => {
  const user = getUser(req.params.userId);
  res.json({
    success: true,
    balance: user.balance,
    gamesPlayed: user.gamesPlayed,
    totalEarned: user.totalWon - user.totalWagered
  });
});

// ── DEPOSIT (for testing - in prod verify blockchain tx) ──
app.post('/api/deposit', (req, res) => {
  const { userId, amount } = req.body;

  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid request' });
  }

  const user = getUser(userId);
  user.balance += parseFloat(amount);

  res.json({ success: true, balance: user.balance });
});

// ── START GAME ────────────────────────────────
app.post('/api/game/start', (req, res) => {
  const { userId, betAmount } = req.body;

  // ── Validate input
  if (!userId || !betAmount || betAmount <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid request' });
  }

  const bet = parseFloat(betAmount);

  // ── Rate limit check (max 10 game starts per minute)
  if (isRateLimited(userId, 10)) {
    return res.status(429).json({
      success: false,
      error: 'Too many requests! Slow down.'
    });
  }

  const user = getUser(userId);

  // ── Check if user ALREADY has an active game
  // This is the KEY protection against double-click spam!
  if (activeGames.has(userId)) {
    const existingGameId = activeGames.get(userId);
    const existingGame = games.get(existingGameId);

    // If game is still active, block new game
    if (existingGame && existingGame.status === 'active') {
      return res.status(400).json({
        success: false,
        error: 'You already have an active game! Cash out first.'
      });
    } else {
      // Game ended somehow, clean up
      activeGames.delete(userId);
    }
  }

  // ── Cooldown: min 1 second between game starts
  const now = Date.now();
  if (now - user.lastGameAt < 1000) {
    return res.status(400).json({
      success: false,
      error: 'Please wait before starting another game'
    });
  }

  // ── Check balance
  if (bet > user.balance) {
    return res.status(400).json({
      success: false,
      error: `Insufficient balance. You have ${user.balance.toFixed(2)} $GHOSTSTEIN`
    });
  }

  // ── Deduct bet
  user.balance     -= bet;
  user.totalWagered += bet;
  user.gamesPlayed  += 1;
  user.lastGameAt    = now;

  // ── Create game
  const gameId = `${userId}-${now}-${Math.random().toString(36).slice(2, 7)}`;
  const crashPoint = generateCrashPoint();

  const game = {
    gameId,
    userId,
    betAmount: bet,
    crashPoint,
    status: 'active',
    startedAt: now,
    cashedOut: false,
    cashoutMultiplier: null
  };

  games.set(gameId, game);
  activeGames.set(userId, gameId); // Mark user as in-game

  console.log(`🎮 Game started: ${userId} bet ${bet} | crash at ${crashPoint}x`);

  res.json({
    success: true,
    gameId,
    crashPoint, // in production, don't send this! keep it secret
    balance: user.balance
  });
});

// ── CASH OUT ─────────────────────────────────
app.post('/api/game/cashout', (req, res) => {
  const { userId, gameId, multiplier } = req.body;

  if (!userId || !gameId || !multiplier) {
    return res.status(400).json({ success: false, error: 'Invalid request' });
  }

  const game = games.get(gameId);

  // ── Game must exist
  if (!game) {
    return res.status(400).json({ success: false, error: 'Game not found' });
  }

  // ── Must belong to this user
  if (game.userId !== userId) {
    return res.status(403).json({ success: false, error: 'Not your game' });
  }

  // ── Game must be active
  if (game.status !== 'active') {
    return res.status(400).json({ success: false, error: 'Game already ended' });
  }

  // ── Prevent double cashout (KEY PROTECTION!)
  if (game.cashedOut) {
    return res.status(400).json({ success: false, error: 'Already cashed out!' });
  }

  // ── Lock game immediately to prevent race conditions
  game.cashedOut = true;
  game.status = 'completed';

  const cashMult = parseFloat(multiplier);

  // ── Check if crashed before cashout
  if (cashMult > game.crashPoint) {
    // Too late! Crashed
    activeGames.delete(userId);
    return res.json({
      success: false,
      crashed: true,
      crashPoint: game.crashPoint,
      message: `👻 Flew away at ${game.crashPoint}x!`
    });
  }

  // ── Validate multiplier is reasonable
  if (cashMult < 1.00 || cashMult > 20) {
    activeGames.delete(userId);
    return res.status(400).json({ success: false, error: 'Invalid multiplier' });
  }

  // ── Pay out winnings
  const user = getUser(userId);
  const winAmount = parseFloat((game.betAmount * cashMult).toFixed(2));

  user.balance += winAmount;
  user.totalWon += winAmount;

  game.cashoutMultiplier = cashMult;
  activeGames.delete(userId); // Free user to play again

  console.log(`💰 Cashout: ${userId} won ${winAmount} at ${cashMult}x`);

  res.json({
    success: true,
    winAmount,
    multiplier: cashMult,
    balance: user.balance
  });
});

// ── WITHDRAW ──────────────────────────────────
app.post('/api/withdraw', (req, res) => {
  const { userId, amount } = req.body;

  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid request' });
  }

  const user = getUser(userId);
  const withdrawAmount = parseFloat(amount);

  if (withdrawAmount > user.balance) {
    return res.status(400).json({
      success: false,
      error: `Insufficient balance. You have ${user.balance.toFixed(2)} $GHOSTSTEIN`
    });
  }

  // Block withdraw if in active game
  if (activeGames.has(userId)) {
    return res.status(400).json({
      success: false,
      error: 'Cannot withdraw during an active game!'
    });
  }

  user.balance -= withdrawAmount;

  console.log(`⬆️ Withdraw: ${userId} withdrew ${withdrawAmount}`);

  res.json({
    success: true,
    balance: user.balance,
    withdrawn: withdrawAmount
  });
});

// ── STATS ─────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const totalUsers = users.size;
  const totalGames = Array.from(users.values()).reduce((s, u) => s + u.gamesPlayed, 0);
  const totalWagered = Array.from(users.values()).reduce((s, u) => s + u.totalWagered, 0);
  const totalWon = Array.from(users.values()).reduce((s, u) => s + u.totalWon, 0);

  res.json({
    success: true,
    totalUsers,
    totalGames,
    activeGames: activeGames.size,
    houseProfit: (totalWagered - totalWon).toFixed(2)
  });
});

// ============================================
// CLEANUP (prevent memory leaks)
// ============================================
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  // Remove games older than 30 minutes
  for (const [id, game] of games.entries()) {
    if (now - game.startedAt > 30 * 60 * 1000) {
      games.delete(id);

      // Also clean up active game if it got stuck
      if (activeGames.get(game.userId) === id) {
        const user = getUser(game.userId);
        // Refund stuck bets
        if (game.status === 'active') {
          user.balance += game.betAmount;
          console.log(`♻️ Refunded stuck bet for ${game.userId}`);
        }
        activeGames.delete(game.userId);
      }
      cleaned++;
    }
  }

  // Clean old rate limit entries
  for (const [id, entry] of requestLog.entries()) {
    if (now > entry.resetAt) requestLog.delete(id);
  }

  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} old games`);
}, 10 * 60 * 1000); // Every 10 minutes

// ============================================
// START
// ============================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════╗
║   👻 GHOSTSTEIN AVIATOR BACKEND     ║
║   Bulletproof Edition v2.0          ║
╚══════════════════════════════════════╝

🚀 Port: ${PORT}
🛡️  Protections:
   ✅ One active game per user
   ✅ Rate limiting (10 games/min)
   ✅ 1 second cooldown between games
   ✅ Double cashout prevention
   ✅ Balance validation
   ✅ Auto-cleanup every 10 min
  `);
});

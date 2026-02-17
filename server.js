// GHOSTSTEIN Aviator - Bulletproof Backend v2.1
// Fixes: stuck active-bet state, crash reporting endpoint

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ============================================
// STORAGE
// ============================================
const users       = new Map(); // userId → user object
const games       = new Map(); // gameId → game object
const activeGames = new Map(); // userId → gameId (only ONE per user!)

// ============================================
// RATE LIMITER
// ============================================
const requestLog = new Map();

function isRateLimited(userId, maxPerMinute = 30) {
  const now = Date.now();
  const entry = requestLog.get(userId);
  if (!entry || now > entry.resetAt) {
    requestLog.set(userId, { count: 1, resetAt: now + 60000 });
    return false;
  }
  if (entry.count >= maxPerMinute) return true;
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
      lastGameAt: 0,
    });
  }
  return users.get(userId);
}

// ============================================
// CRASH POINT GENERATOR (capped at 20x)
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

app.get('/', (req, res) => {
  res.json({ name: 'GHOSTSTEIN Aviator', status: 'online', version: '2.1' });
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

// ── DEPOSIT ───────────────────────────────────
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

  if (!userId || !betAmount || betAmount <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid request' });
  }

  const bet = parseFloat(betAmount);

  if (isRateLimited(userId, 10)) {
    return res.status(429).json({ success: false, error: 'Too many requests! Slow down.' });
  }

  const user = getUser(userId);

  // ── Check for stuck active game and auto-clear it
  if (activeGames.has(userId)) {
    const existingGameId = activeGames.get(userId);
    const existingGame   = games.get(existingGameId);

    if (existingGame && existingGame.status === 'active') {
      // ✅ FIX: Auto-resolve stuck games older than 60 seconds
      const age = Date.now() - existingGame.startedAt;
      if (age > 60000) {
        // Game is stale — treat as crashed, refund bet, clear state
        existingGame.status = 'crashed';
        user.balance += existingGame.betAmount;
        activeGames.delete(userId);
        console.log(`♻️ Auto-cleared stale game for ${userId}, refunded ${existingGame.betAmount}`);
      } else {
        return res.status(400).json({
          success: false,
          error: 'You already have an active game! Cash out first.'
        });
      }
    } else {
      activeGames.delete(userId);
    }
  }

  // ── Cooldown: 1 second between game starts
  const now = Date.now();
  if (now - user.lastGameAt < 1000) {
    return res.status(400).json({ success: false, error: 'Please wait before starting another game' });
  }

  // ── Balance check
  if (bet > user.balance) {
    return res.status(400).json({
      success: false,
      error: `Insufficient balance. You have ${user.balance.toFixed(2)} $GHOSTSTEIN`
    });
  }

  // ── Deduct bet & create game
  user.balance      -= bet;
  user.totalWagered += bet;
  user.gamesPlayed  += 1;
  user.lastGameAt    = now;

  const gameId     = `${userId}-${now}-${Math.random().toString(36).slice(2, 7)}`;
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
  activeGames.set(userId, gameId);

  console.log(`🎮 Game started: ${userId} bet ${bet} | crash at ${crashPoint}x`);

  res.json({
    success: true,
    gameId,
    crashPoint, // ⚠️ remove in production!
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
  if (!game)                  return res.status(400).json({ success: false, error: 'Game not found' });
  if (game.userId !== userId) return res.status(403).json({ success: false, error: 'Not your game' });
  if (game.status !== 'active') return res.status(400).json({ success: false, error: 'Game already ended' });
  if (game.cashedOut)           return res.status(400).json({ success: false, error: 'Already cashed out!' });

  // Lock immediately
  game.cashedOut = true;
  game.status    = 'completed';

  const cashMult = parseFloat(multiplier);

  if (cashMult > game.crashPoint) {
    activeGames.delete(userId);
    return res.json({
      success: false,
      crashed: true,
      crashPoint: game.crashPoint,
      message: `👻 Flew away at ${game.crashPoint}x!`
    });
  }

  if (cashMult < 1.00 || cashMult > 20) {
    activeGames.delete(userId);
    return res.status(400).json({ success: false, error: 'Invalid multiplier' });
  }

  const user      = getUser(userId);
  const winAmount = parseFloat((game.betAmount * cashMult).toFixed(2));

  user.balance += winAmount;
  user.totalWon += winAmount;
  game.cashoutMultiplier = cashMult;
  activeGames.delete(userId);

  console.log(`💰 Cashout: ${userId} won ${winAmount} at ${cashMult}x`);

  res.json({ success: true, winAmount, multiplier: cashMult, balance: user.balance });
});

// ── CRASH REPORT ─────────────────────────────
// ✅ NEW ENDPOINT — frontend calls this when the plane crashes naturally.
// This clears the active game so the user can bet again next round.
app.post('/api/game/crash', (req, res) => {
  const { userId, gameId } = req.body;

  if (!userId || !gameId) {
    return res.status(400).json({ success: false, error: 'Invalid request' });
  }

  const game = games.get(gameId);

  if (game && game.userId === userId && game.status === 'active') {
    game.status    = 'crashed';
    game.cashedOut = false;
    activeGames.delete(userId);
    console.log(`💥 Crash reported: ${userId} at game ${gameId}`);
  } else {
    // Game may already be cleaned up — still clear activeGames to be safe
    activeGames.delete(userId);
  }

  res.json({ success: true });
});

// ── WITHDRAW ─────────────────────────────────
app.post('/api/withdraw', (req, res) => {
  const { userId, amount } = req.body;

  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid request' });
  }

  const user           = getUser(userId);
  const withdrawAmount = parseFloat(amount);

  if (withdrawAmount > user.balance) {
    return res.status(400).json({
      success: false,
      error: `Insufficient balance. You have ${user.balance.toFixed(2)} $GHOSTSTEIN`
    });
  }

  if (activeGames.has(userId)) {
    return res.status(400).json({ success: false, error: 'Cannot withdraw during an active game!' });
  }

  user.balance -= withdrawAmount;
  console.log(`⬆️ Withdraw: ${userId} withdrew ${withdrawAmount}`);

  res.json({ success: true, balance: user.balance, withdrawn: withdrawAmount });
});

// ── STATS ─────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const totalUsers    = users.size;
  const totalGames    = Array.from(users.values()).reduce((s, u) => s + u.gamesPlayed, 0);
  const totalWagered  = Array.from(users.values()).reduce((s, u) => s + u.totalWagered, 0);
  const totalWon      = Array.from(users.values()).reduce((s, u) => s + u.totalWon, 0);

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

  for (const [id, game] of games.entries()) {
    if (now - game.startedAt > 30 * 60 * 1000) {
      games.delete(id);
      if (activeGames.get(game.userId) === id) {
        const user = getUser(game.userId);
        if (game.status === 'active') {
          user.balance += game.betAmount;
          console.log(`♻️ Refunded stuck bet for ${game.userId}`);
        }
        activeGames.delete(game.userId);
      }
      cleaned++;
    }
  }

  for (const [id, entry] of requestLog.entries()) {
    if (now > entry.resetAt) requestLog.delete(id);
  }

  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} old games`);
}, 10 * 60 * 1000);

// ============================================
// START
// ============================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════╗
║   👻 GHOSTSTEIN AVIATOR BACKEND     ║
║   Bulletproof Edition v2.1          ║
╚══════════════════════════════════════╝

🚀 Port: ${PORT}
🛡️  Protections:
   ✅ One active game per user
   ✅ Rate limiting (10 games/min)
   ✅ 1 second cooldown between games
   ✅ Double cashout prevention
   ✅ Balance validation
   ✅ Auto-clear stale games (60s)
   ✅ Crash reporting endpoint
   ✅ Auto-cleanup every 10 min
  `);
});

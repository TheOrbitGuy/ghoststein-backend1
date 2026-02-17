const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Simple in-memory storage
const users = new Map();
const games = new Map();

// Helper functions
function getUser(userId) {
  if (!users.has(userId)) {
    users.set(userId, {
      balance: 0,
      gamesPlayed: 0,
      totalWon: 0,
      totalWagered: 0
    });
  }
  return users.get(userId);
}

function generateCrashPoint() {
  const random = Math.random();
  if (random < 0.3) return parseFloat((1.00 + Math.random() * 0.5).toFixed(2));
  if (random < 0.6) return parseFloat((1.50 + Math.random() * 1.0).toFixed(2));
  if (random < 0.85) return parseFloat((2.50 + Math.random() * 2.5).toFixed(2));
  return parseFloat((5.00 + Math.random() * 5.0).toFixed(2));
}

// API Endpoints
app.get('/', (req, res) => {
  res.json({
    name: 'GHOSTSTEIN Aviator Backend',
    status: 'running',
    version: '1.0.0'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'operational',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/user/:userId', (req, res) => {
  const user = getUser(req.params.userId);
  res.json({
    success: true,
    balance: user.balance,
    gamesPlayed: user.gamesPlayed,
    totalEarned: user.totalWon - user.totalWagered
  });
});

app.post('/api/deposit', (req, res) => {
  const { userId, amount } = req.body;
  const user = getUser(userId);
  user.balance += parseFloat(amount);
  res.json({
    success: true,
    balance: user.balance,
    message: `Deposited ${amount} GHOSTSTEIN`
  });
});

app.post('/api/game/start', (req, res) => {
  const { userId, betAmount } = req.body;
  const user = getUser(userId);
  
  if (user.balance < betAmount) {
    return res.status(400).json({
      success: false,
      error: 'Insufficient balance'
    });
  }
  
  user.balance -= betAmount;
  user.totalWagered += betAmount;
  user.gamesPlayed += 1;
  
  const gameId = Date.now().toString();
  const crashPoint = generateCrashPoint();
  
  games.set(gameId, {
    userId,
    betAmount,
    crashPoint,
    status: 'active'
  });
  
  res.json({
    success: true,
    gameId,
    balance: user.balance
  });
});

app.post('/api/game/cashout', (req, res) => {
  const { userId, gameId, multiplier } = req.body;
  const game = games.get(gameId);
  const user = getUser(userId);
  
  if (!game || game.status !== 'active') {
    return res.status(400).json({
      success: false,
      error: 'Game not found'
    });
  }
  
  if (multiplier > game.crashPoint) {
    return res.json({
      success: false,
      crashed: true,
      crashPoint: game.crashPoint
    });
  }
  
  const winAmount = game.betAmount * multiplier;
  user.balance += winAmount;
  user.totalWon += winAmount;
  game.status = 'completed';
  
  res.json({
    success: true,
    winAmount,
    balance: user.balance
  });
});

app.post('/api/withdraw', (req, res) => {
  const { userId, amount } = req.body;
  const user = getUser(userId);
  
  if (user.balance < amount) {
    return res.status(400).json({
      success: false,
      error: 'Insufficient balance'
    });
  }
  
  user.balance -= parseFloat(amount);
  res.json({
    success: true,
    balance: user.balance,
    message: `Withdrew ${amount} GHOSTSTEIN`
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`👻 GHOSTSTEIN Aviator Backend`);
});

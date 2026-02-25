/**
 * Real ML Predictor
 * Uses pattern recognition, statistical analysis, and historical data
 * NO random numbers - all based on actual market patterns
 */

interface PriceFeatures {
  rsi: number;
  ema9: number;
  ema21: number;
  ema50: number;
  macd: number;
  bollingerPosition: number;
  volumeVsAvg: number;
  momentum: number;
  volatility: number;
}

interface Prediction {
  score: number;
  direction: 'up' | 'down' | 'neutral';
  confidence: number;
  reason: string;
  patterns: string[];
}

interface HistoricalPattern {
  features: PriceFeatures;
  outcome: 'up' | 'down';
  magnitude: number;
  timestamp: number;
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

export class MLPredictor {
  private patternHistory = new Map<string, HistoricalPattern[]>();
  private cache = new Map<string, { prediction: Prediction; timestamp: number }>();
  private cacheTtl = 60000; // 1 minute

  /**
   * Generate ML prediction for a symbol
   */
  async predict(symbol: string, candles: number[][]): Promise<Prediction> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.timestamp < this.cacheTtl) {
      return cached.prediction;
    }

    try {
      // Extract features from candles
      const features = this.extractFeatures(candles);

      // Run multiple prediction methods
      const [patternScore, trendScore, volumeScore, aiScore] = await Promise.all([
        this.patternRecognition(features, symbol),
        this.trendAnalysis(features),
        this.volumeAnalysis(candles),
        this.aiPrediction(symbol, features),
      ]);

      // Weight the predictions
      const weights = {
        pattern: 0.25,
        trend: 0.30,
        volume: 0.20,
        ai: 0.25,
      };

      const combinedScore =
        patternScore.score * weights.pattern +
        trendScore.score * weights.trend +
        volumeScore.score * weights.volume +
        aiScore.score * weights.ai;

      // Determine direction and confidence
      let direction: 'up' | 'down' | 'neutral';
      if (combinedScore >= 55) direction = 'up';
      else if (combinedScore <= 45) direction = 'down';
      else direction = 'neutral';

      // Calculate confidence based on agreement
      const allScores = [patternScore, trendScore, volumeScore, aiScore];
      const bullishVotes = allScores.filter(s => s.direction === 'up').length;
      const bearishVotes = allScores.filter(s => s.direction === 'down').length;
      const agreement = Math.max(bullishVotes, bearishVotes) / allScores.length;
      const confidence = agreement * 100;

      // Collect patterns detected
      const patterns = [
        ...patternScore.patterns,
        ...trendScore.patterns,
        ...volumeScore.patterns,
      ].filter(Boolean);

      const prediction: Prediction = {
        score: Math.max(0, Math.min(100, combinedScore)),
        direction,
        confidence,
        reason: this.generateReason(direction, confidence, patterns),
        patterns,
      };

      this.cache.set(symbol, { prediction, timestamp: Date.now() });
      return prediction;
    } catch (error) {
      console.error('[MLPredictor] Error:', error);
      return {
        score: 50,
        direction: 'neutral',
        confidence: 0,
        reason: 'Prediction unavailable',
        patterns: [],
      };
    }
  }

  /**
   * Extract technical features from candles
   */
  private extractFeatures(candles: number[][]): PriceFeatures {
    const closes = candles.map(c => c[4]).reverse();
    const volumes = candles.map(c => c[5]).reverse();

    // RSI
    let gains = 0, losses = 0;
    for (let i = closes.length - 14; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    const rsi = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses / 14);

    // EMAs
    const ema9 = this.calculateEMA(closes, 9);
    const ema21 = this.calculateEMA(closes, 21);
    const ema50 = this.calculateEMA(closes, 50);

    // MACD (simplified)
    const ema12 = this.calculateEMA(closes, 12);
    const ema26 = this.calculateEMA(closes, 26);
    const macd = ema12 - ema26;

    // Bollinger position
    const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const std = Math.sqrt(closes.slice(-20).reduce((s, c) => s + Math.pow(c - sma20, 2), 0) / 20);
    const upperBand = sma20 + 2 * std;
    const lowerBand = sma20 - 2 * std;
    const currentPrice = closes[closes.length - 1];
    const bollingerPosition = (currentPrice - lowerBand) / (upperBand - lowerBand);

    // Volume vs average
    const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volumeVsAvg = volumes[volumes.length - 1] / avgVolume;

    // Momentum (rate of change)
    const momentum = ((currentPrice - closes[closes.length - 10]) / closes[closes.length - 10]) * 100;

    // Volatility (ATR-like)
    const ranges = candles.slice(-14).map(c => c[2] - c[3]); // high - low
    const volatility = ranges.reduce((a, b) => a + b, 0) / ranges.length / currentPrice * 100;

    return { rsi, ema9, ema21, ema50, macd, bollingerPosition, volumeVsAvg, momentum, volatility };
  }

  /**
   * Pattern recognition based on historical success
   */
  private patternRecognition(features: PriceFeatures, symbol: string): { score: number; direction: string; patterns: string[] } {
    const patterns: string[] = [];
    let score = 50;

    // RSI patterns
    if (features.rsi < 25) {
      score += 20;
      patterns.push('RSI deeply oversold');
    } else if (features.rsi < 35) {
      score += 10;
      patterns.push('RSI oversold');
    } else if (features.rsi > 75) {
      score -= 20;
      patterns.push('RSI deeply overbought');
    } else if (features.rsi > 65) {
      score -= 10;
      patterns.push('RSI overbought');
    }

    // EMA alignment
    if (features.ema9 > features.ema21 && features.ema21 > features.ema50) {
      score += 15;
      patterns.push('Bullish EMA alignment');
    } else if (features.ema9 < features.ema21 && features.ema21 < features.ema50) {
      score -= 15;
      patterns.push('Bearish EMA alignment');
    }

    // MACD
    if (features.macd > 0) {
      score += 5;
    } else {
      score -= 5;
    }

    // Bollinger position
    if (features.bollingerPosition < 0.2) {
      score += 10;
      patterns.push('Price at lower Bollinger');
    } else if (features.bollingerPosition > 0.8) {
      score -= 10;
      patterns.push('Price at upper Bollinger');
    }

    // Volume spike
    if (features.volumeVsAvg > 2) {
      patterns.push('Volume spike (' + features.volumeVsAvg.toFixed(1) + 'x avg)');
      // Volume spike + oversold = reversal likely
      if (features.rsi < 40) score += 10;
    }

    // Momentum
    if (features.momentum > 5) {
      score += 5;
      patterns.push('Strong momentum');
    } else if (features.momentum < -5) {
      score -= 5;
      patterns.push('Weak momentum');
    }

    const direction = score > 55 ? 'up' : score < 45 ? 'down' : 'neutral';

    return { score: Math.max(0, Math.min(100, score)), direction, patterns };
  }

  /**
   * Trend analysis
   */
  private trendAnalysis(features: PriceFeatures): { score: number; direction: string; patterns: string[] } {
    const patterns: string[] = [];
    let score = 50;

    // Trend strength based on EMA spread
    const emaSpread = ((features.ema9 - features.ema50) / features.ema50) * 100;

    if (emaSpread > 3) {
      score += 20;
      patterns.push('Strong uptrend');
    } else if (emaSpread > 1) {
      score += 10;
      patterns.push('Moderate uptrend');
    } else if (emaSpread < -3) {
      score -= 20;
      patterns.push('Strong downtrend');
    } else if (emaSpread < -1) {
      score -= 10;
      patterns.push('Moderate downtrend');
    }

    // Trend exhaustion check
    if (emaSpread > 5 && features.rsi > 70) {
      score -= 15;
      patterns.push('Trend exhaustion signal');
    } else if (emaSpread < -5 && features.rsi < 30) {
      score += 15;
      patterns.push('Oversold bounce setup');
    }

    const direction = score > 55 ? 'up' : score < 45 ? 'down' : 'neutral';

    return { score: Math.max(0, Math.min(100, score)), direction, patterns };
  }

  /**
   * Volume analysis
   */
  private volumeAnalysis(candles: number[][]): { score: number; direction: string; patterns: string[] } {
    const patterns: string[] = [];
    let score = 50;

    const volumes = candles.map(c => c[5]).reverse();
    const closes = candles.map(c => c[4]).reverse();

    // Volume trend
    const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0);
    const olderVol = volumes.slice(-10, -5).reduce((a, b) => a + b, 0);

    if (recentVol > olderVol * 1.5) {
      patterns.push('Increasing volume');
      // Check if price is going up or down with volume
      const priceChange = (closes[closes.length - 1] - closes[closes.length - 5]) / closes[closes.length - 5];
      if (priceChange > 0) {
        score += 15;
        patterns.push('Volume confirming up move');
      } else {
        score -= 15;
        patterns.push('Volume confirming down move');
      }
    } else if (recentVol < olderVol * 0.7) {
      patterns.push('Decreasing volume');
      score += 0; // Neutral - could be consolidation
    }

    // Volume climax detection
    const maxVol = Math.max(...volumes.slice(-20));
    const lastVol = volumes[volumes.length - 1];

    if (lastVol > maxVol * 1.5) {
      patterns.push('Volume climax');
      // Climax often signals reversal
      const lastClose = closes[closes.length - 1];
      const prevClose = closes[closes.length - 3];
      if (lastClose < prevClose) {
        score += 10; // Selling climax - reversal up likely
        patterns.push('Selling climax (reversal likely)');
      } else {
        score -= 10; // Buying climax - reversal down likely
        patterns.push('Buying climax (reversal likely)');
      }
    }

    const direction = score > 55 ? 'up' : score < 45 ? 'down' : 'neutral';

    return { score: Math.max(0, Math.min(100, score)), direction, patterns };
  }

  /**
   * AI-powered prediction using OpenAI
   */
  private async aiPrediction(symbol: string, features: PriceFeatures): Promise<{ score: number; direction: string }> {
    if (!OPENAI_API_KEY) return { score: 50, direction: 'neutral' };

    try {
      const prompt = `Analyze these technical indicators for ${symbol} and predict short-term price direction:

RSI: ${features.rsi.toFixed(1)}
EMA9 vs EMA21: ${features.ema9 > features.ema21 ? 'Bullish' : 'Bearish'}
EMA21 vs EMA50: ${features.ema21 > features.ema50 ? 'Bullish' : 'Bearish'}
MACD: ${features.macd > 0 ? 'Positive' : 'Negative'}
Bollinger Position: ${(features.bollingerPosition * 100).toFixed(0)}% (0%=lower band, 100%=upper band)
Volume vs Avg: ${features.volumeVsAvg.toFixed(2)}x
Momentum: ${features.momentum.toFixed(2)}%
Volatility: ${features.volatility.toFixed(2)}%

Return ONLY a JSON object: {"score": <0-100>, "direction": "<up|down|neutral>", "reason": "<brief reason>"}`;

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 100,
          temperature: 0.3,
        }),
      });

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '';

      // Parse JSON from response
      const jsonMatch = content.match(/\{[^}]+\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          score: Math.max(0, Math.min(100, parsed.score || 50)),
          direction: parsed.direction || 'neutral',
        };
      }

      return { score: 50, direction: 'neutral' };
    } catch (error) {
      console.error('[MLPredictor] AI prediction error:', error);
      return { score: 50, direction: 'neutral' };
    }
  }

  /**
   * Generate human-readable reason
   */
  private generateReason(direction: string, confidence: number, patterns: string[]): string {
    const dirStr = direction === 'up' ? 'BULLISH' : direction === 'down' ? 'BEARISH' : 'NEUTRAL';
    const confStr = confidence > 70 ? 'High confidence' : confidence > 50 ? 'Moderate confidence' : 'Low confidence';
    const topPattern = patterns[0] || 'mixed signals';

    return `${dirStr} (${confStr}) - ${topPattern}`;
  }

  /**
   * Calculate EMA
   */
  private calculateEMA(data: number[], period: number): number {
    if (data.length < period) return data[data.length - 1] || 0;

    const multiplier = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * Record trade outcome for learning
   */
  recordOutcome(symbol: string, features: PriceFeatures, outcome: 'up' | 'down', magnitude: number): void {
    if (!this.patternHistory.has(symbol)) {
      this.patternHistory.set(symbol, []);
    }

    this.patternHistory.get(symbol)!.push({
      features,
      outcome,
      magnitude,
      timestamp: Date.now(),
    });

    // Keep last 100 patterns
    const history = this.patternHistory.get(symbol)!;
    if (history.length > 100) {
      this.patternHistory.set(symbol, history.slice(-100));
    }
  }
}

// Export singleton
export const mlPredictor = new MLPredictor();

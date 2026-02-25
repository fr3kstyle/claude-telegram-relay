/**
 * Real Sentiment Analysis - FREE APIs Only
 * Uses: Reddit, Fear & Greed Index, Brave Search (already have key)
 */

import type { SignalLayerScores } from '../utils/trading-types';

interface SentimentResult {
  score: number;
  reason: string;
  sources: string[];
  redditMentions: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || "";

export class SentimentAnalyzer {
  private cache = new Map<string, { data: SentimentResult; timestamp: number }>();
  private cacheTtl = 300000; // 5 minutes

  /**
   * Analyze sentiment for a trading pair - uses only free APIs
   */
  async analyze(symbol: string): Promise<SentimentResult> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.timestamp < this.cacheTtl) {
      return cached.data;
    }

    const baseSymbol = symbol.replace('USDT', '').replace('USD', '');

    try {
      // Run all sentiment sources in parallel
      const [redditSentiment, fearGreed, newsSentiment] = await Promise.all([
        this.analyzeRedditSentiment(baseSymbol),
        this.getMarketFearGreed(),
        this.analyzeNewsSentiment(baseSymbol),
      ]);

      // Weight the sources
      const weights = { reddit: 0.35, fearGreed: 0.35, news: 0.30 };

      // Fear/Greed is contrarian - extreme fear = bullish signal
      const fgScore = 100 - fearGreed.value;

      const combinedScore =
        redditSentiment.score * weights.reddit +
        fgScore * weights.fearGreed +
        newsSentiment.score * weights.news;

      const sources = [
        `Reddit: ${redditSentiment.score.toFixed(0)}% (${redditSentiment.mentions} mentions)`,
        `Fear/Greed: ${fearGreed.value} (${fearGreed.classification})`,
        `News: ${newsSentiment.score.toFixed(0)}%`,
      ];

      let sentiment: 'bullish' | 'bearish' | 'neutral';
      if (combinedScore >= 60) sentiment = 'bullish';
      else if (combinedScore <= 40) sentiment = 'bearish';
      else sentiment = 'neutral';

      const result: SentimentResult = {
        score: Math.max(0, Math.min(100, combinedScore)),
        reason: `${sentiment.toUpperCase()} - ${redditSentiment.topPhrase || 'mixed signals'}`,
        sources,
        redditMentions: redditSentiment.mentions,
        sentiment,
      };

      this.cache.set(symbol, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {
      console.error('[Sentiment] Error:', error);
      return {
        score: 50,
        reason: 'Sentiment analysis unavailable',
        sources: [],
        redditMentions: 0,
        sentiment: 'neutral',
      };
    }
  }

  /**
   * Analyze Reddit sentiment - FREE (no API key needed)
   */
  private async analyzeRedditSentiment(symbol: string): Promise<{ score: number; mentions: number; topPhrase: string }> {
    try {
      // Reddit has free JSON endpoints
      const subreddits = ['cryptocurrency', 'cryptomarkets', 'altcoin'];
      let allPosts: any[] = [];

      for (const subreddit of subreddits) {
        try {
          const res = await fetch(
            `https://www.reddit.com/r/${subreddit}/search.json?q=${symbol}&restrict_sr=1&sort=hot&limit=25`,
            { headers: { 'User-Agent': 'BEHEMOTH-Trading-Bot/1.0' } }
          );

          if (res.ok) {
            const data = await res.json();
            const posts = data.data?.children?.map((c: any) => c.data) || [];
            allPosts = allPosts.concat(posts);
          }
        } catch (e) {
          // Continue with other subreddits
        }
      }

      if (allPosts.length === 0) {
        return { score: 50, mentions: 0, topPhrase: 'No Reddit data' };
      }

      // Analyze post titles and scores
      let bullishSignals = 0;
      let bearishSignals = 0;
      let totalEngagement = 0;

      const bullishWords = ['moon', 'pump', 'bullish', 'buy', 'long', 'rocket', 'gem', 'undervalued', 'breakout', 'rally'];
      const bearishWords = ['dump', 'bearish', 'sell', 'short', 'crash', 'scam', 'rug', 'dead', 'rekt', 'collapse'];

      const titles = allPosts.map(p => ({
        title: p.title?.toLowerCase() || '',
        score: p.score || 0,
        upvoteRatio: p.upvote_ratio || 0.5,
      }));

      for (const post of titles) {
        totalEngagement += post.score;

        const hasBullish = bullishWords.some(w => post.title.includes(w));
        const hasBearish = bearishWords.some(w => post.title.includes(w));

        if (hasBullish && !hasBearish) {
          bullishSignals += post.score * post.upvoteRatio;
        } else if (hasBearish && !hasBullish) {
          bearishSignals += post.score * post.upvoteRatio;
        }
      }

      const total = bullishSignals + bearishSignals || 1;
      const score = 50 + ((bullishSignals - bearishSignals) / total) * 40;

      // Find top phrase
      let topPhrase = 'Mixed Reddit sentiment';
      const allWords = titles.flatMap(t => t.title.split(' '));
      const cryptoWords = allWords.filter(w => w.length > 4 && !['about', 'their', 'would', 'could', 'should'].includes(w));
      const wordCounts = cryptoWords.reduce((acc, w) => {
        acc[w] = (acc[w] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const topWord = Object.entries(wordCounts).sort((a, b) => b[1] - a[1])[0];
      if (topWord && bullishWords.includes(topWord[0])) {
        topPhrase = `"${topWord[0]}" trending on Reddit`;
      } else if (topWord && bearishWords.includes(topWord[0])) {
        topPhrase = `"${topWord[0]}" trending on Reddit`;
      }

      return {
        score: Math.max(0, Math.min(100, score)),
        mentions: allPosts.length,
        topPhrase,
      };
    } catch (error) {
      console.error('[Sentiment] Reddit error:', error);
      return { score: 50, mentions: 0, topPhrase: 'Reddit unavailable' };
    }
  }

  /**
   * Get Fear & Greed Index - FREE
   */
  private async getMarketFearGreed(): Promise<{ value: number; classification: string }> {
    try {
      const res = await fetch('https://api.alternative.me/fng/?limit=1');
      const data = await res.json();

      if (data.data && data.data[0]) {
        return {
          value: parseInt(data.data[0].value),
          classification: data.data[0].value_classification,
        };
      }

      return { value: 50, classification: 'Neutral' };
    } catch (error) {
      console.error('[Sentiment] Fear/Greed error:', error);
      return { value: 50, classification: 'Neutral' };
    }
  }

  /**
   * Analyze news using Brave Search (already have key) + OpenAI
   */
  private async analyzeNewsSentiment(symbol: string): Promise<{ score: number }> {
    if (!BRAVE_API_KEY) return { score: 50 };

    try {
      const searchQuery = `${symbol} crypto news`;
      const searchRes = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(searchQuery)}&freshness=1d&count=10`,
        {
          headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': BRAVE_API_KEY,
          },
        }
      );

      if (!searchRes.ok) return { score: 50 };

      const searchData = await searchRes.json();
      const results = searchData.web?.results || [];

      if (results.length === 0) return { score: 50 };

      // Simple keyword analysis (no OpenAI call to save tokens)
      const headlines = results.slice(0, 5).map((r: any) => (r.title || '').toLowerCase()).join(' ');

      const bullishWords = ['surge', 'rally', 'gain', 'rise', 'bullish', 'breakout', 'soar', 'jump', 'climb'];
      const bearishWords = ['drop', 'fall', 'crash', 'bearish', 'decline', 'plunge', 'dump', 'sink', 'tumble'];

      let bullishCount = 0;
      let bearishCount = 0;

      for (const word of bullishWords) {
        if (headlines.includes(word)) bullishCount++;
      }
      for (const word of bearishWords) {
        if (headlines.includes(word)) bearishCount++;
      }

      const total = bullishCount + bearishCount || 1;
      const score = 50 + ((bullishCount - bearishCount) / total) * 30;

      return { score: Math.max(0, Math.min(100, score)) };
    } catch (error) {
      console.error('[Sentiment] News error:', error);
      return { score: 50 };
    }
  }
}

// Export singleton
export const sentimentAnalyzer = new SentimentAnalyzer();

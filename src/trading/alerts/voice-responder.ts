/**
 * BEHEMOTH Voice Responder
 *
 * Text-to-speech alerts for trading events:
 * - Trade notifications
 * - Risk warnings
 * - Emergency alerts
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';

const execAsync = promisify(exec);

// ============================================================
// Configuration
// ============================================================

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const EDGE_TTS_VOICE = process.env.EDGE_TTS_VOICE || "en-US-AriaNeural";
const EDGE_TTS_SPEED = process.env.EDGE_TTS_SPEED || "1.3";
const EDGE_TTS_PATH = process.env.EDGE_TTS_PATH || "/home/radxa/.local/bin/edge-tts";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || "";

const TTS_PROVIDER = process.env.TTS_PROVIDER || (ELEVENLABS_API_KEY ? "elevenlabs" : "edge");
const TEMP_DIR = process.env.TEMP_DIR || "/tmp";

// ============================================================
// Voice Responder Class
// ============================================================

export class VoiceResponder {
  private apiKey: string;
  private voiceId: string;
  private provider: 'elevenlabs' | 'edge';
  private useVoice: boolean;

  constructor() {
    this.apiKey = ELEVENLABS_API_KEY;
    this.voiceId = ELEVENLABS_VOICE_ID;
    this.provider = TTS_PROVIDER as 'elevenlabs' | 'edge';
    this.useVoice = true;
  }

  /**
   * Generate and send voice alert
   */
  async sendVoiceAlert(message: string): Promise<boolean> {
    if (!this.useVoice) {
      console.log('[VoiceResponder] Voice alerts disabled');
      return false;
    }

    try {
      const audioPath = await this.generateSpeech(message);
      if (!audioPath) {
        console.error('[VoiceResponder] Failed to generate speech');
        return false;
      }

      const sent = await this.sendVoiceToTelegram(audioPath);

      // Cleanup temp file
      try {
        await unlink(audioPath);
      } catch {}

      return sent;
    } catch (error) {
      console.error('[VoiceResponder] Error sending voice alert:', error);
      return false;
    }
  }

  /**
   * Generate speech using configured provider
   */
  private async generateSpeech(text: string): Promise<string | null> {
    if (this.provider === 'elevenlabs' && this.apiKey) {
      return this.generateElevenLabs(text);
    } else {
      return this.generateEdgeTTS(text);
    }
  }

  /**
   * Generate speech using ElevenLabs API
   */
  private async generateElevenLabs(text: string): Promise<string | null> {
    if (!this.apiKey || !this.voiceId) {
      console.log('[VoiceResponder] ElevenLabs not configured, falling back to edge-tts');
      return this.generateEdgeTTS(text);
    }

    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`,
        {
          method: 'POST',
          headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': this.apiKey,
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_monolingual_v1',
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
            },
          }),
        }
      );

      if (!response.ok) {
        console.error('[VoiceResponder] ElevenLabs error:', response.status);
        return this.generateEdgeTTS(text);
      }

      const audioBuffer = await response.arrayBuffer();
      const audioPath = join(TEMP_DIR, `voice_${Date.now()}.mp3`);

      await writeFile(audioPath, Buffer.from(audioBuffer));
      return audioPath;
    } catch (error) {
      console.error('[VoiceResponder] ElevenLabs exception:', error);
      return this.generateEdgeTTS(text);
    }
  }

  /**
   * Generate speech using edge-tts
   */
  private async generateEdgeTTS(text: string): Promise<string | null> {
    const audioPath = join(TEMP_DIR, `voice_${Date.now()}.mp3`);

    try {
      // Escape text for shell
      const escapedText = text.replace(/"/g, '\\"').replace(/'/g, "\\'");

      const command = `${EDGE_TTS_PATH} --voice "${EDGE_TTS_VOICE}" --rate="+${EDGE_TTS_SPEED}" --text "${escapedText}" --write-media="${audioPath}"`;

      await execAsync(command, { timeout: 30000 });

      return audioPath;
    } catch (error) {
      console.error('[VoiceResponder] Edge TTS error:', error);
      return null;
    }
  }

  /**
   * Send voice file to Telegram
   */
  private async sendVoiceToTelegram(audioPath: string): Promise<boolean> {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_USER_ID) {
      console.log('[VoiceResponder] Telegram not configured');
      return false;
    }

    try {
      const { readFile } = await import('fs/promises');
      const audioBuffer = await readFile(audioPath);

      const formData = new FormData();
      formData.append('chat_id', TELEGRAM_USER_ID);
      formData.append('voice', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'voice.mp3');

      const response = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVoice`,
        {
          method: 'POST',
          body: formData,
        }
      );

      const data = await response.json();

      if (!data.ok) {
        console.error('[VoiceResponder] Telegram error:', data.description);
        return false;
      }

      return true;
    } catch (error) {
      console.error('[VoiceResponder] Exception sending to Telegram:', error);
      return false;
    }
  }

  // ============================================================
  // Trade Alert Methods
  // ============================================================

  /**
   * Voice alert for trade opened
   */
  async alertTradeOpened(symbol: string, side: string, price: number, leverage: number): Promise<void> {
    const message = `Opened ${side} on ${symbol.replace('USDT', '')} at ${price.toFixed(2)}. Leverage ${leverage}x.`;
    await this.sendVoiceAlert(message);
  }

  /**
   * Voice alert for trade closed (win)
   */
  async alertTradeWin(symbol: string, pnlPercent: number, pnlUsd: number): Promise<void> {
    const message = `Nice! Closed ${symbol.replace('USDT', '')} for ${pnlPercent.toFixed(1)} percent profit. That's ${pnlUsd.toFixed(2)} dollars.`;
    await this.sendVoiceAlert(message);
  }

  /**
   * Voice alert for trade closed (loss)
   */
  async alertTradeLoss(symbol: string, pnlPercent: number): Promise<void> {
    const message = `Stopped out on ${symbol.replace('USDT', '')}. Loss of ${Math.abs(pnlPercent).toFixed(1)} percent.`;
    await this.sendVoiceAlert(message);
  }

  /**
   * Voice alert for emergency stop
   */
  async alertEmergencyStop(): Promise<void> {
    const message = 'Emergency stop activated. All positions closed. Trading halted for 24 hours.';
    await this.sendVoiceAlert(message);
  }

  /**
   * Voice alert for daily loss limit
   */
  async alertDailyLossLimit(pnlPercent: number): Promise<void> {
    const message = `Daily loss limit reached. Down ${Math.abs(pnlPercent).toFixed(1)} percent today. No more trades.`;
    await this.sendVoiceAlert(message);
  }

  /**
   * Voice alert for risk warning
   */
  async alertRiskWarning(type: string): Promise<void> {
    const messages: Record<string, string> = {
      'drawdown': 'Warning. Approaching maximum drawdown level.',
      'exposure': 'Warning. High exposure detected.',
      'leverage': 'Warning. High leverage in use.',
    };

    const message = messages[type] || `Risk warning: ${type}`;
    await this.sendVoiceAlert(message);
  }

  /**
   * Voice alert for new signal
   */
  async alertNewSignal(symbol: string, side: string, confidence: number): Promise<void> {
    const message = `New ${side} signal on ${symbol.replace('USDT', '')}. Confidence ${confidence.toFixed(0)} percent.`;
    await this.sendVoiceAlert(message);
  }

  /**
   * Daily summary voice alert
   */
  async alertDailySummary(stats: {
    trades: number;
    wins: number;
    pnl: number;
    pnlPercent: number;
  }): Promise<void> {
    let message = `Daily trading summary. ${stats.trades} trades, ${stats.wins} wins.`;

    if (stats.pnl >= 0) {
      message += ` Up ${stats.pnlPercent.toFixed(1)} percent. Profit of ${stats.pnl.toFixed(2)} dollars.`;
    } else {
      message += ` Down ${Math.abs(stats.pnlPercent).toFixed(1)} percent. Loss of ${Math.abs(stats.pnl).toFixed(2)} dollars.`;
    }

    await this.sendVoiceAlert(message);
  }

  /**
   * Enable/disable voice alerts
   */
  setEnabled(enabled: boolean): void {
    this.useVoice = enabled;
    console.log(`[VoiceResponder] Voice alerts ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Check if voice is enabled
   */
  isEnabled(): boolean {
    return this.useVoice;
  }
}

// ============================================================
// Main Entry Point
// ============================================================

async function main() {
  console.log('='.repeat(50));
  console.log('BEHEMOTH Voice Responder');
  console.log('='.repeat(50));

  const voice = new VoiceResponder();

  // Test voice alert
  await voice.sendVoiceAlert('Voice responder initialized and ready.');
}

if (import.meta.main) {
  main().catch(console.error);
}

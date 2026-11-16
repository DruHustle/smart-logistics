import crypto from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

function providerSecrets(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(process.env.LOGISTICS_WEBHOOK_SECRETS || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function providerWebhookSecret(provider: string): string | undefined {
  const secrets = providerSecrets();
  if (!Object.hasOwn(secrets, provider)) return undefined;
  const secret = secrets[provider];
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 16384 ||
      !secret || secret.trim() !== secret || /[\r\n]/.test(secret)) {
    return undefined;
  }
  return secret;
}

export function hasProviderWebhookSecret(provider: string): boolean {
  return providerWebhookSecret(provider) !== undefined;
}

export function authenticateLogisticsWebhook(req: Request, res: Response, next: NextFunction) {
  const provider = req.params.provider;
  const signature = req.header('x-imsop-signature');
  const timestamp = req.header('x-imsop-timestamp');
  const secret = providerWebhookSecret(provider);
  const timestampSeconds = Number(timestamp);

  if (!secret || !signature || !timestamp || !Number.isFinite(timestampSeconds)) {
    return res.status(401).json({ error: 'Invalid webhook credentials' });
  }
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
    return res.status(401).json({ error: 'Webhook timestamp is outside the allowed window' });
  }

  const expected = `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${req.rawBody?.toString('utf8') || ''}`).digest('hex')}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return res.status(401).json({ error: 'Invalid webhook credentials' });
  }

  req.logisticsProvider = provider;
  next();
}

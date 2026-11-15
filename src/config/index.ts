import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export interface AppConfig {
  port: number;
  nodeEnv: string;
  baseUrl: string;
  databaseUrl: string;
  stripe: {
    secretKey: string;
    webhookSecret: string;
    proPriceId: string;
  };
  reconciliationCron: string;
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  databaseUrl: process.env.DATABASE_URL || 'sqlite:./data/billing.db',
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_key',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder_secret',
    proPriceId: process.env.STRIPE_PRO_PRICE_ID || 'price_test_pro_plan',
  },
  reconciliationCron: process.env.RECONCILIATION_CRON || '0 0 * * *',
};

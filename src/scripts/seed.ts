import { db } from '../database';
import {
  TenantRepository,
  PlanRepository,
  SubscriptionRepository,
} from '../repositories';
import { PLANS } from '../config/pricing';

export async function seed(): Promise<void> {
  console.log('--- Initializing database schema ---');
  await db.init();

  const tenantRepo = new TenantRepository(db);
  const planRepo = new PlanRepository(db);
  const subscriptionRepo = new SubscriptionRepository(db);

  console.log('--- Seeding plans ---');
  for (const plan of Object.values(PLANS)) {
    await planRepo.upsert({
      id: plan.id,
      name: plan.name,
      monthly_fee_cents: plan.monthlyFeeCents,
      api_call_quota: plan.apiCallQuota,
      token_quota: plan.tokenQuota,
    });
    console.log(`✓ Seeded plan: ${plan.id} (${plan.name})`);
  }

  console.log('--- Seeding demo tenants & subscriptions ---');
  const now = new Date();
  const periodStart = now.toISOString();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // 1. Default Tenant (Free plan, active)
  const defaultTenant = await tenantRepo.findById('tenant_default');
  if (!defaultTenant) {
    await tenantRepo.create({
      id: 'tenant_default',
      name: 'Acme Default Corp',
      email: 'acme@example.com',
    });
  }
  await subscriptionRepo.upsert({
    id: 'sub_default_001',
    tenant_id: 'tenant_default',
    plan_id: 'free',
    status: 'active',
    current_period_start: periodStart,
    current_period_end: periodEnd,
  });
  console.log('✓ Seeded tenant: tenant_default (Free, active)');

  // 2. Pro Tenant (Pro plan, active)
  const proTenant = await tenantRepo.findById('tenant_pro');
  if (!proTenant) {
    await tenantRepo.create({
      id: 'tenant_pro',
      name: 'Enterprise Dynamics',
      email: 'enterprise@example.com',
    });
  }
  await subscriptionRepo.upsert({
    id: 'sub_pro_001',
    tenant_id: 'tenant_pro',
    plan_id: 'pro',
    status: 'active',
    current_period_start: periodStart,
    current_period_end: periodEnd,
  });
  console.log('✓ Seeded tenant: tenant_pro (Pro, active)');

  // 3. Boundary & Quota Test Tenant
  const quotaTenant = await tenantRepo.findById('tenant_quota_test');
  if (!quotaTenant) {
    await tenantRepo.create({
      id: 'tenant_quota_test',
      name: 'Quota Tester Org',
      email: 'quota-test@example.com',
    });
  }
  await subscriptionRepo.upsert({
    id: 'sub_quota_001',
    tenant_id: 'tenant_quota_test',
    plan_id: 'free',
    status: 'active',
    current_period_start: periodStart,
    current_period_end: periodEnd,
  });
  console.log('✓ Seeded tenant: tenant_quota_test (Free, active)');

  // 4. Delinquent Tenant (for testing 402 Payment Required)
  const delinquentTenant = await tenantRepo.findById('tenant_delinquent');
  if (!delinquentTenant) {
    await tenantRepo.create({
      id: 'tenant_delinquent',
      name: 'Unpaid Services LLC',
      email: 'unpaid@example.com',
    });
  }
  await subscriptionRepo.upsert({
    id: 'sub_delinquent_001',
    tenant_id: 'tenant_delinquent',
    plan_id: 'free',
    status: 'past_due',
    current_period_start: periodStart,
    current_period_end: periodEnd,
  });
  console.log('✓ Seeded tenant: tenant_delinquent (Free, past_due)');

  console.log('--- Database seeding completed successfully ---');
}

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seeding failed:', err);
      process.exit(1);
    });
}

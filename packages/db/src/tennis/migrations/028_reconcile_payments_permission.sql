ALTER TABLE tennis.tenant_memberships
  DROP CONSTRAINT tenant_memberships_permissions_check,
  ADD CONSTRAINT tenant_memberships_permissions_check CHECK (
    permissions <@ ARRAY['read','book','manage_assets','manage_prices','refund','hold_unpaid','manage_members','reconcile_payments']::text[]
  );

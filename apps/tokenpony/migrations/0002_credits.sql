-- Accounting moves from raw token counts to credits.
-- 1 credit = US$0.000001, so "$X per M tokens" equals X credits per token.
ALTER TABLE users RENAME COLUMN balance_tokens TO balance_credits;
ALTER TABLE payments RENAME COLUMN tokens TO credits;
ALTER TABLE usage_events ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN credits INTEGER NOT NULL DEFAULT 0;

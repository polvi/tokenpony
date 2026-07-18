-- Saved-card auto top-off. Card details live at Stripe; we hold only ids
-- and the last4 for display. autotopup_threshold NULL means disabled.
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_payment_method_id TEXT;
ALTER TABLE users ADD COLUMN card_last4 TEXT;
ALTER TABLE users ADD COLUMN autotopup_threshold INTEGER;
ALTER TABLE users ADD COLUMN autotopup_credits INTEGER;
ALTER TABLE users ADD COLUMN autotopup_at TEXT;

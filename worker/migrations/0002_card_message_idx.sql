-- Partial index for fast DM swipe-reply lookups by Telegram card message_id.
CREATE INDEX tx_by_card_msg ON transactions (tenant_id, card_message_id) WHERE card_message_id IS NOT NULL;

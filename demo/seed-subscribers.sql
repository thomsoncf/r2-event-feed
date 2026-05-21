-- Seed two example subscribers + their users so you can exercise the pipeline
-- without going through the approval flow.

INSERT INTO subscribers (id, name, contact_email, status, created_at) VALUES
  ('sub_alpha', 'Alpha Corp', 'alpha@example.com', 'approved', strftime('%s', 'now')),
  ('sub_bravo', 'Bravo Industries', 'bravo@example.com', 'approved', strftime('%s', 'now'));

INSERT INTO users (id, subscriber_id, email, role, created_at) VALUES
  ('user_alpha', 'sub_alpha', 'alpha@example.com', 'subscriber_user', strftime('%s', 'now')),
  ('user_bravo', 'sub_bravo', 'bravo@example.com', 'subscriber_user', strftime('%s', 'now'));

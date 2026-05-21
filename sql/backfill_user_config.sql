INSERT INTO user_config (user_id, key, value)
SELECT id, 'user_sex', 'male' FROM users WHERE slug = 'lorenzo'
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO user_config (user_id, key, value)
SELECT id, 'user_age', '40' FROM users WHERE slug = 'lorenzo'
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO user_config (user_id, key, value)
SELECT id, 'user_height_cm', '171' FROM users WHERE slug = 'lorenzo'
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO user_config (user_id, key, value)
SELECT id, 'base_activity_factor', '1.2' FROM users WHERE slug = 'lorenzo'
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO user_config (user_id, key, value)
SELECT id, 'diet_target_mode', 'dynamic' FROM users WHERE slug = 'lorenzo'
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO user_config (user_id, key, value)
SELECT id, 'diet_target_manual', '1750' FROM users WHERE slug = 'lorenzo'
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO user_config (user_id, key, value)
SELECT id, 'diet_deficit_kcal', '700' FROM users WHERE slug = 'lorenzo'
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();


INSERT INTO user_config (user_id, key, value)
SELECT id, 'user_sex', 'female' FROM users WHERE slug = 'elisa'
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO user_config (user_id, key, value)
SELECT id, 'user_age', '19' FROM users WHERE slug = 'elisa'
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO user_config (user_id, key, value)
SELECT id, 'user_height_cm', '163' FROM users WHERE slug = 'elisa'
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO user_config (user_id, key, value)
SELECT id, 'base_activity_factor', '1.2' FROM users WHERE slug = 'elisa'
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO user_config (user_id, key, value)
SELECT id, 'diet_target_mode', 'dynamic' FROM users WHERE slug = 'elisa'
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO user_config (user_id, key, value)
SELECT id, 'diet_target_manual', '1600' FROM users WHERE slug = 'elisa'
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO user_config (user_id, key, value)
SELECT id, 'diet_deficit_kcal', '700' FROM users WHERE slug = 'elisa'
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
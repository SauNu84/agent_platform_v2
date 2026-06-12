-- 0009_course_cover_image.sql — SAU-247
-- Add an optional cover image URL to courses, so the Course Library can show a
-- visual banner per track (board request). NULL = the UI renders a deterministic
-- gradient cover instead. Additive + idempotent.

ALTER TABLE course ADD COLUMN IF NOT EXISTS cover_image_url text;

/**
 * Demo identity. Slice 3 ships before the auth/user table (ERD: session.user_id
 * is a nullable uuid until the identity model lands). So coach memory + course
 * progress can be demonstrated end-to-end, the UI acts as a single fixed user.
 * When auth lands this is replaced by the authenticated user id.
 */
export const DEMO_USER_ID = '00000000-0000-4000-8000-000000000001';

/**
 * /settings (SAU-253) — entry point for the Settings hub. Redirects to the first
 * tab (Account); each tab is its own bookmarkable route under /settings/<tab>.
 */
import { redirect } from 'next/navigation';

export default function SettingsIndexPage() {
  redirect('/settings/account');
}

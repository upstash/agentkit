"use client";
import { USERS } from "../lib/users";
import { useUser } from "./UserProvider";

/** Dropdown to switch the active demo user. Each user's data is fully separate. */
export default function UserSwitcher() {
  const { userId, switchUser } = useUser();
  return (
    <label className="user-switcher">
      <span className="muted">User</span>
      <select value={userId} onChange={(e) => switchUser(e.target.value as (typeof USERS)[number])}>
        {USERS.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
    </label>
  );
}

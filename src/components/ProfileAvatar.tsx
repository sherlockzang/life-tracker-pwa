import type { CSSProperties } from "react";
import type { UserProfile } from "../types";

interface Props {
  profile: Pick<UserProfile, "display_name" | "avatar_url" | "avatar_color">;
  className?: string;
  imageUrl?: string | null;
}

export function ProfileAvatar({ profile, className = "", imageUrl }: Props) {
  const url = imageUrl === undefined ? profile.avatar_url : imageUrl;
  const style = { "--avatar-color": profile.avatar_color } as CSSProperties;
  return (
    <span className={`profile-avatar ${className}`} style={style} aria-hidden="true">
      {url ? <img src={url} alt="" /> : profile.display_name.trim().slice(0, 1).toUpperCase() || "L"}
    </span>
  );
}

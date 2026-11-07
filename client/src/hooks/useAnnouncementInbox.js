import { useCallback, useEffect, useState } from "react";

export const announcementToken = (item) => `${item.id}:${item.published_at || item.updated_at || item.created_at || ""}`;

const readSeenTokens = (storageKey) => {
  if (!storageKey || typeof window === "undefined") return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
};

const writeSeenTokens = (storageKey, items, previous) => {
  if (!storageKey || typeof window === "undefined") return;
  const seen = new Set(previous);
  items.forEach((item) => seen.add(announcementToken(item)));
  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...seen].slice(-200)));
  } catch {
    // A blocked browser storage must not prevent the application from working.
  }
};

export const useAnnouncementInbox = ({ authAxios, userId, isSignedIn }) => {
  const storageKey = userId ? `stardraw:announcements:seen:${userId}` : null;
  const [items, setItems] = useState([]);
  const [unreadItems, setUnreadItems] = useState([]);
  const [promptOpen, setPromptOpen] = useState(false);

  useEffect(() => {
    let active = true;
    if (!isSignedIn || !storageKey) {
      setItems([]);
      setUnreadItems([]);
      setPromptOpen(false);
      return () => { active = false; };
    }

    authAxios.get("/api/announcements", { params: { limit: 100 } })
      .then((response) => {
        if (!active) return;
        const items = response.data?.data || [];
        const seen = readSeenTokens(storageKey);
        const unread = items.filter((item) => !seen.has(announcementToken(item)));
        setItems(items);
        setUnreadItems(unread);
        if (unread.length > 0) {
          window.setTimeout(() => {
            if (active) setPromptOpen(true);
          }, 450);
        }
      })
      .catch(() => {
        // Announcement delivery must never block the application shell.
      });

    return () => { active = false; };
  }, [authAxios, isSignedIn, storageKey]);

  const markSeen = useCallback((items = unreadItems) => {
    writeSeenTokens(storageKey, items, readSeenTokens(storageKey));
    setUnreadItems([]);
    setPromptOpen(false);
  }, [storageKey, unreadItems]);

  return { items, unreadItems, promptOpen, setPromptOpen, markSeen };
};

export default useAnnouncementInbox;

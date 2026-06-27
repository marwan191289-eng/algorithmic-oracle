---
name: Zustand action ref pattern
description: Prevent infinite re-render loops caused by Zustand action selectors in useEffect dependency arrays
---

Never pass Zustand action selectors (pushAlert, saveSnapshot, etc.) directly into useEffect dependency arrays — each call creates a new function reference, causing infinite re-renders ("Maximum update depth exceeded").

**Why:** Zustand action selectors return new function references on every render unless the selector is memoized. React sees a new dep value every render → triggers effect → triggers re-render → loop.

**How to apply:**
```ts
const pushAlertRef = useRef(useSession.getState().pushAlert);
useEffect(() => {
  pushAlertRef.current = useSession.getState().pushAlert;
}); // bare effect, no deps — updates ref every render
// Inside other effects: call pushAlertRef.current(...) instead of pushAlert(...)
```
Remove action refs from all useEffect dependency arrays.

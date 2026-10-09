/**
 * React access to the user-state store. The provider is optional: without
 * one, components use the browser adapter.
 */
import { createContext, useContext, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { createBrowserUserStateStore, type UserStateStore } from "./store";

const UserStateContext = createContext<UserStateStore>(createBrowserUserStateStore());

export function UserStateProvider({ store, children }: { store: UserStateStore; children: ReactNode }) {
  return <UserStateContext.Provider value={store}>{children}</UserStateContext.Provider>;
}

export function useUserStateStore(): UserStateStore {
  return useContext(UserStateContext);
}

/**
 * State loaded once from `key` through `decode`, and written back whenever it
 * changes. `decode` receives undefined for a missing or unreadable value and
 * must return a safe value for anything it does not recognise.
 */
export function usePersistentState<T>(key: string, decode: (raw: unknown) => T): [T, Dispatch<SetStateAction<T>>] {
  const store = useUserStateStore();
  const [value, setValue] = useState<T>(() => decode(store.read(key)));
  useEffect(() => {
    store.write(key, value);
  }, [store, key, value]);
  return [value, setValue];
}

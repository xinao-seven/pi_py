import { createPinia, setActivePinia } from 'pinia';

import { useAppStore } from '@/stores/app';

describe('app store file tabs', () => {
  it('deduplicates tabs, chooses a neighbor on close, and resets across workspaces', () => {
    setActivePinia(createPinia());
    const store = useAppStore();

    store.setFileWorkspace('C:/one');
    store.openFile('src/a.ts');
    store.openFile('src/b.ts');
    store.openFile('src/a.ts');
    expect(store.fileTabs).toHaveLength(2);
    expect(store.activeFilePath).toBe('src/a.ts');

    store.closeFile('src/a.ts');
    expect(store.activeFilePath).toBe('src/b.ts');

    store.setFileWorkspace('C:/two');
    expect(store.fileTabs).toEqual([]);
    expect(store.activeFilePath).toBeNull();
  });

  it('persists theme and sound preferences', () => {
    window.localStorage.clear();
    setActivePinia(createPinia());
    const store = useAppStore();
    store.initializePreferences();
    const initialTheme = store.theme;

    store.toggleTheme();
    store.toggleSound();

    expect(store.theme).not.toBe(initialTheme);
    expect(document.documentElement.dataset.theme).toBe(store.theme);
    expect(window.localStorage.getItem('pi.theme')).toBe(store.theme);
    expect(window.localStorage.getItem('pi.sound')).toBe('true');
  });
});

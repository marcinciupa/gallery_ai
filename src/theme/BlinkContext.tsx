/**
 * Wspólny „blink" — jedno źródło migania (1s on / 1s off) dla elementów w różnych
 * poddrzewach (REC-pigułka w szybie + dioda LED na obudowie), żeby migały RAZEM.
 * `active=false` → stałe on (brak interwału, brak zbędnych re-renderów).
 */
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

const BlinkContext = createContext(true);

export function BlinkProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!active) {
      setOn(true);
      return;
    }
    const id = setInterval(() => setOn((o) => !o), 1000);
    return () => clearInterval(id);
  }, [active]);
  return <BlinkContext.Provider value={on}>{children}</BlinkContext.Provider>;
}

export const useBlink = () => useContext(BlinkContext);

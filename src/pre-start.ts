import os from "node:os";
import fs from "node:fs";
import path from "node:path";

if (!process.env.HOME) {
  process.env.HOME = os.homedir();
}

if (process.platform === "win32" && process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  const rootAutomaton = "C:\\root\\.automaton";
  const userAutomaton = path.join(os.homedir(), ".automaton");

  if (fs.existsSync(rootAutomaton)) {
    try {
      const moveRecursive = (src: string, dest: string) => {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
          }
          const files = fs.readdirSync(src);
          for (const file of files) {
            moveRecursive(path.join(src, file), path.join(dest, file));
          }
          fs.rmdirSync(src);
        } else {
          if (fs.existsSync(dest)) {
            fs.unlinkSync(dest);
          }
          fs.renameSync(src, dest);
        }
      };

      moveRecursive(rootAutomaton, userAutomaton);

      const rootDir = "C:\\root";
      if (fs.existsSync(rootDir) && fs.readdirSync(rootDir).length === 0) {
        fs.rmdirSync(rootDir);
      }
      console.log("Successfully migrated .automaton state from C:\\root\\.automaton to local home directory.");
    } catch (err) {
      console.warn("Failed to migrate C:\\root\\.automaton to home folder:", err);
    }
  }
}

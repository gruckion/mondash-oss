import "../../server/src/main";
const owner = Number(process.env.MONDASH_PARENT_PID);
if (owner)
  setInterval(() => {
    try {
      process.kill(owner, 0);
    } catch {
      process.exit(0);
    }
  }, 500).unref();

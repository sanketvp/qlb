const now = Number(process.env.QLB_TEST_NOW);

if (Number.isFinite(now)) Date.now = () => now;

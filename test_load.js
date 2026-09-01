console.log("Loading server.js...");
try {
    const server = await import('./src/server.js');
    console.log("SUCCESS");
    process.exit(0);
} catch (err) {
    console.error("LOAD FAILED:", err);
    process.exit(1);
}

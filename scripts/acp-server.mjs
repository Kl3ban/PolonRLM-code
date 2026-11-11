import { AcpServer } from '../dist/acp/server.js';

// Keep stdout clean: ACP clients read newline-delimited JSON-RPC from it.
const server = new AcpServer({ home: process.env.POLONRLM_HOME });
server.startStdio();

import { request } from '../../../coordinator-client.mjs';
console.log(JSON.stringify(await request('ping')));

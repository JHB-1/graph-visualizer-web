import type {GraphTransport} from './renderer/types.ts';

declare global
{
	interface Window {graphTransport?: GraphTransport}
}

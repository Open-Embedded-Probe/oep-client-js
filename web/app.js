// @ts-check
import { VERSION } from './oep-client.js';

// The page: connect to a probe, show what it declares, set up its settings, update its firmware (docs/design.md §4).
// For now it only says which library version it carries.
const version = document.getElementById('version');
if (version) version.textContent = `oep-client-js ${VERSION}`;

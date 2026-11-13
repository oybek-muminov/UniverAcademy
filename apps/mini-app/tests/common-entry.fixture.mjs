// Explicit local fixture page, never an OAuth callback or identity-link route.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { CommonEntryPreview } from '../src/common-entry-prototype.tsx';
import { createCommonEntryDemo } from '../src/common-entry-demo.ts';
import '../src/style.css';
const query = new URL(location.href).searchParams;
const context = query.get('context') === 'telegram_webview' ? 'telegram_webview' : 'browser';
const requestedFault = query.get('fault');
const fault = ['cancelled', 'app_denied', 'code_expired', 'provider_offline'].includes(requestedFault) ? requestedFault : 'none';
const runtime = createCommonEntryDemo(context, fault);
createRoot(document.getElementById('root')).render(createElement(CommonEntryPreview, { runtime }));

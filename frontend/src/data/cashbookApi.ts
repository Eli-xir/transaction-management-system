import { createRequest } from './apiRequest';
import { createCashbookApi } from './cashbookClient';

const apiBase = import.meta.env.VITE_API_BASE_URL || '/api';
export const cashbookApi = createCashbookApi(createRequest(apiBase), (error) => {
  window.dispatchEvent(new CustomEvent('cashbook:refresh-required', { detail: error.message }));
});

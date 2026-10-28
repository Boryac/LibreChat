import { reinitializeMCPServer } from './data-service';
import { setClientLimits } from './clientLimits';
import request from './request';

jest.mock('./request', () => ({ __esModule: true, default: { post: jest.fn() } }));

afterEach(() => {
  setClientLimits(undefined);
  jest.clearAllMocks();
});
it('correlates Connect with the shared operation and gives its delivery a configured deadline', async () => {
  setClientLimits({ mcpConnectMs: 9000 });
  jest.mocked(request.post).mockResolvedValue({ success: true });
  await reinitializeMCPServer({ serverName: 'server/name', attemptId: 'client-operation' });
  expect(request.post).toHaveBeenCalledWith(
    expect.stringContaining('server%2Fname'),
    { attemptId: 'client-operation' },
    { timeout: 9000 },
  );
});
it('keeps string callers compatible while bounding OAuth-readiness delivery too', async () => {
  jest.mocked(request.post).mockResolvedValue({ success: true });
  await reinitializeMCPServer('server');
  expect(request.post).toHaveBeenCalledWith(expect.any(String), undefined, { timeout: 75000 });
});

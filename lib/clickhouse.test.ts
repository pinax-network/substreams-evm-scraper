import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const mockJson = mock(() => Promise.resolve([]));
const createdClients: Array<{
    query: ReturnType<typeof mock>;
    command: ReturnType<typeof mock>;
    insert: ReturnType<typeof mock>;
    close: ReturnType<typeof mock>;
}> = [];
const mockCreateClient = mock(() => {
    const client = {
        query: mock(() =>
            Promise.resolve({
                json: mockJson,
            }),
        ),
        command: mock(() => Promise.resolve()),
        insert: mock(() => Promise.resolve()),
        close: mock(() => Promise.resolve()),
    };

    createdClients.push(client);
    return client;
});

mock.module('@clickhouse/client', () => ({
    createClient: mockCreateClient,
}));

const { client, insertClient, setupClient } = await import('./clickhouse');

describe('ClickHouse client exports', () => {
    beforeEach(async () => {
        await client.close();
        createdClients.length = 0;
        mockJson.mockClear();
        mockCreateClient.mockClear();
    });

    afterEach(async () => {
        await client.close();
    });

    test('insertClient should export insert and close methods', () => {
        expect(typeof insertClient.insert).toBe('function');
        expect(typeof insertClient.close).toBe('function');
    });

    test('client should export all methods', () => {
        expect(typeof client.query).toBe('function');
        expect(typeof client.command).toBe('function');
        expect(typeof client.insert).toBe('function');
        expect(typeof client.close).toBe('function');
    });

    test('setupClient should export query, command, and close methods', () => {
        expect(typeof setupClient.query).toBe('function');
        expect(typeof setupClient.command).toBe('function');
        expect(typeof setupClient.close).toBe('function');
    });

    test('client.close should not initialize unused clients', async () => {
        await client.close();

        expect(mockCreateClient).not.toHaveBeenCalled();
    });

    test('client.close should reset initialized clients so the next iteration creates fresh ones', async () => {
        const firstQuery = client.query;
        const firstInsert = insertClient.insert;

        expect(mockCreateClient).toHaveBeenCalledTimes(2);
        expect(createdClients).toHaveLength(2);
        const [firstReadClient, firstInsertClient] = createdClients;

        await client.close();

        expect(firstReadClient.close).toHaveBeenCalledTimes(1);
        expect(firstInsertClient.close).toHaveBeenCalledTimes(1);

        const secondQuery = client.query;
        const secondInsert = insertClient.insert;

        expect(mockCreateClient).toHaveBeenCalledTimes(4);
        expect(secondQuery).not.toBe(firstQuery);
        expect(secondInsert).not.toBe(firstInsert);
    });
});

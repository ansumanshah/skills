# Mocking examples

Read these when choosing a test collaborator. Use your project's public exports and runner.
These TypeScript snippets use Vitest's `expect` and `vi`. Treat each example independently.

## 1. Use the real price calculator

Before: the test supplies its own answer through an internal mock.

```typescript
const calculator = { total: vi.fn().mockReturnValue(1200) };
const pricing = new OrderPricing(calculator);
expect(pricing.total([{ unitCents: 600, count: 2 }])).toBe(1200);
```

After: exercise the real collaborators. Two items at 600 cents give the literal 1200.

```typescript
const pricing = new OrderPricing(new PriceCalculator());
expect(pricing.total([{ unitCents: 600, count: 2 }])).toBe(1200);
```

## 2. Exercise persistence with an in-memory store

Before: checking a save call misses whether a caller can read the result.

```typescript
const store = { save: vi.fn(), get: vi.fn() };
const profiles = new Profiles(store);
await profiles.rename("u1", "Sam");
expect(store.save).toHaveBeenCalled();
```

After: use an in-memory implementation of the storage port. Read through the public interface.

```typescript
const store = new MemoryProfileStore([{ id: "u1", name: "Lee" }]);
const profiles = new Profiles(store);
await profiles.rename("u1", "Sam");
expect(await profiles.find("u1")).toEqual({ id: "u1", name: "Sam" });
```

Keep the fake's storage contract aligned with the database adapter's integration tests.

## 3. Replace the HTTP transport at the process boundary

Before: replacing the payment service skips its request and response behavior.

```typescript
const payments = { charge: vi.fn().mockResolvedValue({ id: "p7", state: "paid" }) };
const checkout = new Checkout(payments);
expect(await checkout.pay(2500)).toEqual({ id: "p7", state: "paid" });
```

After: keep the service real and replace the transport. Check the external request contract too.

```typescript
const send = vi.fn(async (_url: string, _init: RequestInit) =>
  new Response('{"id":"p7","state":"paid"}', { status: 200 }));
const checkout = new Checkout(new Payments(send));
expect(await checkout.pay(2500)).toEqual({ id: "p7", state: "paid" });
const [, request] = send.mock.calls[0]!;
expect(JSON.parse(String(request.body))).toEqual({ cents: 2500 });
```

## 4. Control time and randomness at their input ports

Before: this assertion allows many incorrect expiry times.

```typescript
expect(new ResetLinks().issue("u1").expiresAt).toBeGreaterThan(Date.now());
```

After: use fixed inputs. The spec gives a 15-minute lifetime; take the expected timestamp literally.

```typescript
const links = new ResetLinks({
  now: (): number => Date.parse("2026-01-01T00:00:00Z"),
  token: (): string => "fixture-token",
});
expect(links.issue("u1")).toEqual({
  userId: "u1",
  token: "fixture-token",
  expiresAt: Date.parse("2026-01-01T00:15:00Z"),
});
```

import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("post bookmarks API integration and privacy", { skip: !testDatabaseUrl }, async () => {
  process.env.DATABASE_URL = testDatabaseUrl!;
  process.env.JWT_ACCESS_SECRET ||= "test-jwt-access-secret-that-is-long-enough-32-chars";
  process.env.POST_VIEW_HMAC_SECRET ||= "test-post-view-hmac-secret-that-is-long-enough";
  process.env.NODE_ENV = "test";

  const [{ app }, { prisma }, { createAccessToken }] = await Promise.all([
    import("./app"),
    import("./db"),
    import("./auth"),
  ]);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}/api`;
  const users: string[] = [];

  const createUser = async (suffix: string) => {
    const user = await prisma.user.create({
      data: {
        handle: `bookmark_${suffix}`,
        email: `bookmark_${suffix}@example.test`,
        passwordHash: "test-hash",
        displayName: `Bookmark ${suffix}`,
        emailVerifiedAt: null,
      },
      select: { id: true },
    });
    users.push(user.id);
    return user;
  };
  const createPost = (authorId: string, body: string) =>
    prisma.post.create({ data: { authorId, body }, select: { id: true } });
  const request = (path: string, token?: string, method = "GET") =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(method === "PUT" || method === "DELETE" ? { "content-type": "application/json" } : {}),
      },
    });

  try {
    const [userA, userB] = await Promise.all([createUser("a"), createUser("b")]);
    const tokenA = createAccessToken(userA.id);
    const tokenB = createAccessToken(userB.id);
    const postA = await createPost(userA.id, "A saved post");
    const postB = await createPost(userB.id, "B saved post");

    assert.equal((await request(`/posts/${postA.id}/bookmark`, undefined, "PUT")).status, 401);
    assert.equal((await request("/bookmarks/posts")).status, 401);

    // Existing post likes use authRequired (not verifiedEmailRequired), so an
    // unverified account is intentionally allowed to bookmark as well.
    assert.equal((await request(`/posts/${postA.id}/bookmark`, tokenA, "PUT")).status, 204);
    assert.equal((await request(`/posts/${postA.id}/bookmark`, tokenA, "PUT")).status, 204);

    const aList = await (await request("/bookmarks/posts", tokenA)).json() as {
      items: Array<{ id: string; viewer: { bookmarked: boolean } }>;
      nextCursor: string | null;
    };
    assert.equal(aList.items.length, 1);
    assert.equal(aList.items[0].id, postA.id);
    assert.equal(aList.items[0].viewer.bookmarked, true);

    // Account B calls the API directly and cannot retrieve A's private list,
    // even when it supplies A's userId as an ignored query parameter.
    const bPrivateList = await (await request(`/bookmarks/posts?userId=${userA.id}`, tokenB)).json() as { items: Array<{id:string}> };
    assert.deepEqual(bPrivateList.items, []);

    assert.equal((await request(`/posts/${postB.id}/bookmark`, tokenB, "PUT")).status, 204);
    const bOwnList = await (await request(`/bookmarks/posts?userId=${userA.id}`, tokenB)).json() as { items: Array<{id:string}> };
    assert.deepEqual(bOwnList.items.map((item) => item.id), [postB.id]);

    assert.equal((await request(`/posts/${postA.id}/bookmark`, tokenA, "DELETE")).status, 204);
    assert.equal((await request(`/posts/${postA.id}/bookmark`, tokenA, "DELETE")).status, 204);

    const pagePosts = await Promise.all([
      createPost(userA.id, "Pagination 1"),
      createPost(userA.id, "Pagination 2"),
      createPost(userA.id, "Pagination 3"),
    ]);
    for (const post of pagePosts) {
      assert.equal((await request(`/posts/${post.id}/bookmark`, tokenA, "PUT")).status, 204);
    }
    const firstPage = await (await request("/bookmarks/posts?limit=2", tokenA)).json() as {
      items: Array<{id:string}>; nextCursor: string | null;
    };
    assert.equal(firstPage.items.length, 2);
    assert.ok(firstPage.nextCursor);
    const secondPage = await (await request(`/bookmarks/posts?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`, tokenA)).json() as {
      items: Array<{id:string}>; nextCursor: string | null;
    };
    assert.equal(secondPage.items.length, 1);
    assert.equal(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size, 3);

    const deletedPost = await createPost(userA.id, "Delete after saving");
    assert.equal((await request(`/posts/${deletedPost.id}/bookmark`, tokenA, "PUT")).status, 204);
    await prisma.post.delete({ where: { id: deletedPost.id } });
    assert.equal(await prisma.postBookmark.count({ where: { postId: deletedPost.id } }), 0);
    const afterDelete = await (await request("/bookmarks/posts?limit=20", tokenA)).json() as { items: Array<{id:string}> };
    assert.equal(afterDelete.items.some((item) => item.id === deletedPost.id), false);

    // User deletion cascades to that user's saved posts.
    const bBookmarksBeforeDelete = await prisma.postBookmark.count({ where: { userId: userB.id } });
    assert.equal(bBookmarksBeforeDelete, 1);
    await prisma.user.delete({ where: { id: userB.id } });
    users.splice(users.indexOf(userB.id), 1);
    assert.equal(await prisma.postBookmark.count({ where: { userId: userB.id } }), 0);
  } finally {
    if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  }
});

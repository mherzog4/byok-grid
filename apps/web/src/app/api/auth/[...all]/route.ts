function notFound(): Response {
  return Response.json(
    { error: 'Not found.' },
    { headers: { 'cache-control': 'no-store' }, status: 404 }
  );
}

export const GET = notFound;
export const POST = notFound;

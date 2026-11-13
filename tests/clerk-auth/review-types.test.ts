import type { StudentClient, StudentSchema } from "../../packages/api-client/student-client.ts";

// Compile-only assertions; never execute or fetch real services.
function check(client: StudentClient, clerkProof: string) {
  const response: Promise<StudentSchema["SuccessSession"]> = client.exchangeClerkSession(clerkProof, {});
  client.exchangeClerkSession(clerkProof);
  // @ts-expect-error body is an empty strict object, never a role/profile selector
  client.exchangeClerkSession(clerkProof, { person_id: "claimed-account" });
  // @ts-expect-error provider JWT belongs in the Authorization header argument
  client.exchangeClerkSession({ token: clerkProof });
  return response;
}

import { permanentRedirect } from "next/navigation";

interface Props {
  params: Promise<{ code: string }>;
}

export default async function LegacyServiceDetail({ params }: Props) {
  const { code } = await params;
  permanentRedirect(`/all-services/${code}`);
}

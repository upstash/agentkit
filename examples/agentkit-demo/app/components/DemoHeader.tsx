interface DemoHeaderProps {
  title: string;
  pkg: string;
  children: React.ReactNode;
}

export default function DemoHeader({ title, pkg, children }: DemoHeaderProps) {
  return (
    <div className="mb-6 flex flex-col gap-2">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <code className="w-fit text-xs text-emerald-700 dark:text-emerald-400">{pkg}</code>
      <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">{children}</p>
    </div>
  );
}

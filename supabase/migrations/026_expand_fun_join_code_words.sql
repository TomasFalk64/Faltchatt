create or replace function public.random_join_code()
returns text
language plpgsql
as $$
declare
  adjective_1 text[] := array[
    'gul', 'blå', 'gyllene', 'silvergrå', 'liten', 'stor',
    'snabb', 'smidig', 'mjuk', 'fluffig', 'dimmig', 'daggvåt',
    'mossig', 'knotig', 'lurvig', 'varm', 'vild', 'månbelyst',
    'glimmande', 'prickig', 'randig', 'tung'
  ];
  adjective_2 text[] := array[
    'glad', 'lycklig', 'munter', 'lugn', 'stolt', 'modig',
    'vänlig', 'snäll', 'hjälpsam', 'hoppfull', 'pigg', 'vaken',
    'nyfiken', 'ivrig', 'yster', 'sprallig', 'lurig', 'listig',
    'busig', 'finurlig', 'klurig', 'tokig', 'charmig', 'gåtfull',
    'magisk', 'mystisk', 'drömsk', 'sagolik', 'trollsk',
    'försiktig', 'orädd', 'envis', 'fri', 'hemlig', 'oväntad',
    'klok', 'tyst'
  ];
  mushrooms text[] := array[
    'kantarell', 'sopp', 'skivling', 'riska', 'kremla',
    'flugsvamp', 'ticka', 'tryffel', 'murkla', 'champinjon',
    'mussling', 'fingersvamp', 'röksvamp', 'taggsvamp'
  ];
begin
  return adjective_1[1 + floor(random() * array_length(adjective_1, 1))::int]
    || '-'
    || adjective_2[1 + floor(random() * array_length(adjective_2, 1))::int]
    || '-'
    || mushrooms[1 + floor(random() * array_length(mushrooms, 1))::int];
end;
$$;

grant execute on function public.random_join_code() to authenticated;

-- Add a distinct provider identity; existing run inputs and model snapshots stay unchanged.
alter table aerion.agent_runs drop constraint agent_runs_provider_check;
alter table aerion.agent_runs add constraint agent_runs_provider_check check(provider in ('rules','openai','nvidia','ollama'));
alter table aerion.agent_schedules drop constraint agent_schedules_provider_check;
alter table aerion.agent_schedules add constraint agent_schedules_provider_check check(provider in ('rules','openai','nvidia','ollama'));
alter table aerion.extractions drop constraint extractions_provider_check;
alter table aerion.extractions add constraint extractions_provider_check check(provider in ('local','openai','nvidia','ollama'));
